// 程式進入點：連接資料夾 → 載入資料 → 顯示頁籤
import { h } from './util.js';
import { APP_VERSION } from './version.js';
import { Store, CorruptError, TooNewError, normalize } from './store.js';
import {
  FolderStorage, folderApiSupported, rememberedHandle, rememberHandle, forgetHandle,
  permissionState, requestPermission, shadow,
} from './folder-storage.js';
import { openDialog, confirmDialog, alertDialog } from './ui/dialog.js';
import { createStatusBadge } from './ui/status.js';
import {
  unsupportedScreen, anotherWindowScreen, firstRunScreen, reauthorizeScreen, messageScreen,
} from './ui/setup.js';
import { renderEventsTab } from './ui/events-tab.js';
import { renderStaffTab } from './ui/staff-tab.js';
import { renderSettingsTab } from './ui/settings-tab.js';

const root = document.getElementById('app');
const TABS = [['events', '活動專案'], ['staff', '人員管理'], ['settings', '設定']];

let store = null;
let storage = null;
let currentTab = 'events';
let badge = null;
let content = null;
let tabsEl = null;
let bannerHost = null;
let swReg = null;
let pendingUpdate = false;
let unsubscribe = [];

// ---------------------------------------------------------------- 啟動
async function main() {
  registerServiceWorker();
  if (!folderApiSupported()) { root.replaceChildren(unsupportedScreen()); return; }
  if (!(await acquireLock())) { root.replaceChildren(anotherWindowScreen()); return; }
  window.addEventListener('beforeunload', (e) => {
    if (store && ['saving', 'error', 'conflict'].includes(store.status.state)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && store) store.flush().catch(() => {});
  });
  await startFromRemembered();
}

// 同一時間只允許一個視窗使用，避免兩個視窗互相覆蓋資料
function acquireLock() {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request('shift-scheduler-main', { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return undefined; }
      resolve(true);
      return new Promise(() => {}); // 持有到頁面關閉
    });
  });
}

async function startFromRemembered() {
  let handle = null;
  try { handle = await rememberedHandle(); } catch (e) { handle = null; }
  if (!handle) { showFirstRun(); return; }
  const perm = await permissionState(handle);
  if (perm === 'granted') await connect(handle);
  else showReauthorize(handle);
}

function showFirstRun() {
  root.replaceChildren(firstRunScreen({ onChoose: () => chooseFolder() }));
}

function showReauthorize(handle) {
  root.replaceChildren(reauthorizeScreen({
    folderName: handle.name,
    onAuthorize: async () => {
      try {
        const p = await requestPermission(handle);
        if (p === 'granted') await connect(handle);
      } catch (e) {
        await alertDialog(`無法授權：${e.message}`);
      }
    },
    onChooseOther: () => chooseFolder(),
  }));
}

async function chooseFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'shift-scheduler', mode: 'readwrite', startIn: 'documents' });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    await alertDialog(`無法使用這個資料夾：${e.message}`);
    return;
  }
  try {
    if (store) { await store.flush(); await shadow.clear().catch(() => {}); }
    await rememberHandle(handle);
  } catch (e) {
    await alertDialog(`無法記住這個資料夾：${e.message}`);
    return;
  }
  await connect(handle);
}

// ---------------------------------------------------------------- 連接資料夾
async function connect(handle) {
  for (const fn of unsubscribe) fn();
  unsubscribe = [];
  storage = new FolderStorage(handle);
  store = new Store(storage, { shadow });
  let existed = false;
  try {
    existed = await store.open();
  } catch (e) {
    if (e instanceof CorruptError) { await handleCorruptFile(); return; }
    if (e instanceof TooNewError) {
      root.replaceChildren(messageScreen('需要更新程式', e.message,
        [{ label: '重新整理', kind: 'primary', onClick: () => location.reload() }]));
      return;
    }
    root.replaceChildren(messageScreen('無法讀取資料夾', `${e.message}\n請改選其他資料夾，或確認資料夾是否仍存在。`,
      [{ label: '改選其他資料夾', kind: 'primary', onClick: () => chooseFolder() }]));
    return;
  }
  try { await storage.backupOnOpen(); } catch (e) { console.warn('自動備份失敗', e); }
  const recovered = await maybeRecoverShadow();
  if (!existed) store.commit(); // 建立資料檔，同時確認資料夾可以寫入
  buildLayout();
  if (!existed || recovered) await store.flush();
}

// 上次有修改尚未存入資料夾（例如授權過期時）→ 詢問是否還原
async function maybeRecoverShadow() {
  let sh = null;
  try { sh = await shadow.read(); } catch (e) { sh = null; }
  if (!sh || !sh.dirty || !sh.data) return false;
  const fileTs = Date.parse(store.data.savedAt || 0) || 0;
  const shTs = Date.parse(sh.data.savedAt || 0) || 0;
  if (shTs <= fileTs) { await shadow.write(store.data, false).catch(() => {}); return false; }
  const ok = await confirmDialog(
    '發現上次有一些修改還沒有存進資料夾（可能是授權過期或資料夾暫時無法寫入）。\n要把這些修改還原回來嗎？',
    { title: '還原未存檔的修改', okLabel: '還原', });
  if (ok) {
    try { store.replaceAll(sh.data); return true; } catch (e) { await alertDialog(`無法還原：${e.message}`); return false; }
  }
  await shadow.write(store.data, false).catch(() => {});
  return false;
}

async function handleCorruptFile() {
  const list = await storage.listBackups().catch(() => []);
  const actions = [];
  if (list.length) {
    actions.push({
      label: '用最新的備份還原', kind: 'primary',
      onClick: async () => {
        try {
          await storage.quarantineCorrupt();
          const { json } = await storage.readBackup(list[0].name);
          store = new Store(storage, { shadow });
          store.data = normalize(json);
          store.commit();
          await store.flush();
          await connect(storage.dir);
        } catch (e) {
          await alertDialog(`還原失敗：${e.message}`);
        }
      },
    });
  }
  actions.push({ label: '改選其他資料夾', onClick: () => chooseFolder() });
  root.replaceChildren(messageScreen('資料檔損毀',
    list.length
      ? `資料夾裡的資料檔無法讀取。系統找到 ${list.length} 份備份，可以用最新的一份還原（損毀的檔案會另存到「備份」資料夾，不會被刪除）。`
      : '資料夾裡的資料檔無法讀取，而且沒有找到備份。損毀的檔案不會被刪除，請改選其他資料夾，或聯絡管理者協助。',
    actions));
}

// ---------------------------------------------------------------- 畫面
function buildLayout() {
  badge = createStatusBadge({
    onRetry: () => store.retry(),
    onConflict: () => handleConflict(),
    onReauthorize: () => {},
  });
  tabsEl = h('div', { class: 'tabs' }, TABS.map(([id, label]) =>
    h('button', { class: `tab ${id === currentTab ? 'active' : ''}`, dataset: { tab: id }, onclick: () => selectTab(id) }, label)));
  bannerHost = h('div');
  content = h('div', { class: 'content' });
  root.replaceChildren(h('div', { class: 'layout' },
    h('div', { class: 'topbar' }, h('h1', null, '短期活動排班系統'), badge.el),
    bannerHost, tabsEl, content));

  unsubscribe.push(store.onStatus((s) => badge.render(s)));
  unsubscribe.push(store.subscribe(() => renderTab()));
  badge.render(store.status);
  if (pendingUpdate) showUpdateBanner();
  renderTab();
}

function selectTab(id) {
  currentTab = id;
  for (const b of tabsEl.children) b.classList.toggle('active', b.dataset.tab === id);
  renderTab();
}

function renderTab() {
  if (!content) return;
  const ctx = { store, storage, actions: { chooseFolder, checkUpdate } };
  if (currentTab === 'events') renderEventsTab(content, ctx);
  else if (currentTab === 'staff') renderStaffTab(content, ctx);
  else renderSettingsTab(content, ctx);
}

async function handleConflict() {
  const r = await openDialog({
    title: '資料夾內的資料已被更改',
    content: '這個資料夾裡的資料，在您操作期間被其他視窗、其他電腦（例如雲端同步）或其他程式更改過。\n\n' +
      '• 重新載入：放棄這個畫面尚未存入的修改，改用資料夾裡目前的內容。\n' +
      '• 覆蓋：以這個畫面的內容取代資料夾裡的內容。',
    buttons: [
      { id: 'cancel', label: '稍後再決定' },
      { id: 'overwrite', label: '以目前畫面覆蓋', kind: 'danger' },
      { id: 'reload', label: '重新載入資料夾內容', kind: 'primary' },
    ],
  });
  if (r === 'reload' || r === 'overwrite') await store.resolveConflict(r);
}

// ---------------------------------------------------------------- 更新（PWA）
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    swReg = reg;
    const notify = () => { if (navigator.serviceWorker.controller) { pendingUpdate = true; showUpdateBanner(); } };
    if (reg.waiting) notify();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed') notify(); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((e) => console.warn('Service Worker 註冊失敗', e));
}

function showUpdateBanner() {
  if (!bannerHost) return;
  bannerHost.replaceChildren(h('div', { class: 'banner' },
    h('span', null, '有新版本可以使用。'),
    h('button', {
      class: 'btn primary small',
      onclick: async () => {
        if (store) await store.flush().catch(() => {});
        if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
        else location.reload();
      },
    }, '立即更新')));
}

async function checkUpdate() {
  if (!swReg) { await alertDialog('目前無法檢查更新（可能沒有網路，或瀏覽器不支援）。'); return; }
  try {
    await swReg.update();
    if (swReg.waiting) { pendingUpdate = true; showUpdateBanner(); await alertDialog('有新版本可以使用，請按上方的「立即更新」。'); }
    else await alertDialog(`目前已是最新版本（${APP_VERSION}）。`, '檢查更新');
  } catch (e) {
    await alertDialog('無法檢查更新，請確認網路連線後再試。');
  }
}

main().catch((e) => {
  console.error(e);
  root.replaceChildren(messageScreen('發生未預期的錯誤', String(e && e.message ? e.message : e),
    [{ label: '重新整理', kind: 'primary', onClick: () => location.reload() }]));
});
