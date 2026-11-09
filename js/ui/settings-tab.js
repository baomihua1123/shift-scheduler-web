// 「設定」頁籤：崗位管理、資料夾與備份
import { h, stamp, fmtDateTime } from '../util.js';
import { openDialog, confirmDialog, alertDialog } from './dialog.js';
import { normalize, TooNewError } from '../store.js';
import { APP_VERSION } from '../version.js';

const state = { selectedId: null, showInactive: false };

async function positionDialog(store, position) {
  const nameInput = h('input', { type: 'text', value: position ? position.name : '', placeholder: '例如：導播' });
  const noteInput = h('input', { type: 'text', value: position ? position.note : '' });
  const result = await openDialog({
    title: position ? '編輯崗位' : '新增崗位',
    content: h('div', null,
      h('label', { class: 'field' }, h('span', null, '崗位名稱'), nameInput),
      h('label', { class: 'field' }, h('span', null, '備註'), noteInput)),
    buttons: [
      { id: 'cancel', label: '取消' },
      {
        id: 'ok', label: '儲存', kind: 'primary',
        validate: () => {
          const n = nameInput.value.trim();
          if (!n) return '請輸入崗位名稱';
          const dup = store.positions({ includeInactive: true }).some((x) => x.name === n && (!position || x.id !== position.id));
          return dup ? `已有同名的崗位：${n}` : '';
        },
      },
    ],
  });
  return result === 'ok' ? { name: nameInput.value, note: noteInput.value } : null;
}

function backupLabel(name) {
  const m = name.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_(.+))?\.json$/);
  if (!m) return name;
  const label = m[7] ? `（${m[7]}）` : '';
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} ${label}`;
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderSettingsTab(container, ctx) {
  const { store, storage, actions } = ctx;

  // ---------------- 崗位 ----------------
  const tbody = h('tbody');
  const editBtn = h('button', { class: 'btn' }, '編輯');
  const delBtn = h('button', { class: 'btn danger' }, '刪除');
  const upBtn = h('button', { class: 'btn' }, '上移');
  const downBtn = h('button', { class: 'btn' }, '下移');
  const restoreBtn = h('button', { class: 'btn' }, '恢復停用的崗位');

  function renderRows() {
    const list = store.positions({ includeInactive: state.showInactive });
    if (state.selectedId !== null && !list.some((p) => p.id === state.selectedId)) state.selectedId = null;
    tbody.replaceChildren();
    if (!list.length) {
      tbody.append(h('tr', null, h('td', { colspan: 3, class: 'empty' }, '還沒有崗位，請按「新增崗位」，例如：導播、攝影。')));
    }
    for (const p of list) {
      tbody.append(h('tr', {
        class: `${p.active ? '' : 'inactive'} ${p.id === state.selectedId ? 'selected' : ''}`,
        onclick: () => { state.selectedId = p.id; renderRows(); },
        ondblclick: () => edit(),
      }, h('td', null, p.name), h('td', null, p.note), h('td', null, p.active ? '使用中' : '已停用')));
    }
    const sel = state.selectedId === null ? null : store.getPosition(state.selectedId);
    editBtn.disabled = !sel;
    delBtn.disabled = !sel || !sel.active;
    upBtn.disabled = !sel;
    downBtn.disabled = !sel;
    restoreBtn.disabled = !sel || sel.active;
  }

  async function add() {
    const v = await positionDialog(store, null);
    if (!v) return;
    try { state.selectedId = store.addPosition(v.name, v.note); } catch (e) { await alertDialog(e.message, '無法新增'); }
  }
  async function edit() {
    const p = store.getPosition(state.selectedId);
    if (!p) return;
    const v = await positionDialog(store, p);
    if (!v) return;
    try { store.updatePosition(p.id, v); } catch (e) { await alertDialog(e.message, '無法儲存'); }
  }
  async function del() {
    const p = store.getPosition(state.selectedId);
    if (!p) return;
    const ok = await confirmDialog(`確定要刪除崗位「${p.name}」嗎？\n（若曾被活動使用，會改為「停用」以保留過往班表。）`,
      { title: '確認刪除', okLabel: '刪除', danger: true });
    if (!ok) return;
    if (store.deletePosition(p.id) === 'deactivated') {
      await alertDialog(`「${p.name}」曾被活動使用，已改為停用；過往班表不受影響。`, '已停用');
    }
  }
  editBtn.onclick = edit;
  delBtn.onclick = del;
  upBtn.onclick = () => { if (state.selectedId !== null) store.movePosition(state.selectedId, -1); };
  downBtn.onclick = () => { if (state.selectedId !== null) store.movePosition(state.selectedId, 1); };
  restoreBtn.onclick = () => { if (state.selectedId !== null) store.setPositionActive(state.selectedId, true); };

  const positionsCard = h('div', { class: 'card' },
    h('h2', null, '崗位管理'),
    h('p', { class: 'muted small' }, '崗位為所有活動共用；順序就是班表由左到右的順序。'),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: add }, '新增崗位'),
      editBtn, delBtn, upBtn, downBtn, restoreBtn, h('span', { class: 'spacer' }),
      h('label', { class: 'small' },
        h('input', { type: 'checkbox', checked: state.showInactive, onchange: (e) => { state.showInactive = e.target.checked; renderRows(); } }),
        ' 顯示已停用的崗位')),
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, '崗位名稱'), h('th', null, '備註'), h('th', null, '狀態'))),
      tbody));

  // ---------------- 資料與備份 ----------------
  const backupBody = h('tbody');
  const backupNote = h('p', { class: 'muted small' }, '讀取中…');

  async function refreshBackups() {
    try {
      const list = await storage.listBackups();
      backupBody.replaceChildren();
      backupNote.textContent = list.length
        ? `每次開啟程式時會自動備份一份，最多保留最近 10 份（內容沒有變動時不會重複備份）。`
        : '目前還沒有備份。下次開啟程式時會自動建立第一份。';
      for (const b of list) {
        backupBody.append(h('tr', null,
          h('td', null, backupLabel(b.name)),
          h('td', { class: 'muted small' }, `${Math.max(1, Math.round(b.size / 1024))} KB`),
          h('td', null, h('button', { class: 'btn small', onclick: () => restoreBackup(b.name) }, '還原此備份'))));
      }
    } catch (e) {
      backupNote.textContent = `無法讀取備份清單：${e.message}`;
    }
  }

  async function restoreBackup(name) {
    const ok = await confirmDialog(
      `要用「${backupLabel(name)}」的備份取代目前所有資料嗎？\n還原前會先自動把目前的資料另存一份備份。`,
      { title: '確認還原', okLabel: '還原', danger: true });
    if (!ok) return;
    try {
      await store.flush();
      const { json } = await storage.readBackup(name);
      normalize(json); // 先驗證
      await storage.backupNow('還原前');
      store.replaceAll(json);
      await store.flush();
      await alertDialog('已還原完成。', '完成');
    } catch (e) {
      await alertDialog(`還原失敗：${e.message}`, '無法還原');
    }
    refreshBackups();
  }

  async function backupNow() {
    try {
      await store.flush();
      const name = await storage.backupNow('手動');
      await alertDialog(name ? '已建立備份。' : '目前沒有資料可備份。', '備份');
    } catch (e) {
      await alertDialog(`備份失敗：${e.message}`, '備份');
    }
    refreshBackups();
  }

  function exportAll() {
    download(`排班資料匯出_${stamp()}.json`, store.exportJSON());
  }

  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json', style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        normalize(json);
        const ok = await confirmDialog(
          `要用「${file.name}」的內容取代目前所有資料嗎？\n匯入前會先自動把目前的資料另存一份備份。`,
          { title: '確認匯入', okLabel: '匯入', danger: true });
        if (!ok) return;
        await store.flush();
        await storage.backupNow('匯入前');
        store.replaceAll(json);
        await store.flush();
        await alertDialog('已匯入完成。', '完成');
      } catch (err) {
        const msg = err instanceof TooNewError ? err.message : `這個檔案無法匯入：${err.message}`;
        await alertDialog(msg, '無法匯入');
      }
      refreshBackups();
    },
  });

  const dataCard = h('div', { class: 'card' },
    h('h2', null, '資料夾與備份'),
    h('p', null, '目前使用的資料夾：', h('strong', null, storage.name)),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => actions.chooseFolder() }, '切換資料夾'),
      h('button', { class: 'btn', onclick: backupNow }, '立即備份'),
      h('button', { class: 'btn', onclick: exportAll }, '匯出完整資料（檔案）'),
      h('button', { class: 'btn', onclick: () => fileInput.click() }, '匯入完整資料（檔案）'),
      fileInput),
    h('p', { class: 'muted small' }, '想把資料搬到另一台電腦：直接複製整個資料夾，在新電腦開啟程式時選擇那個資料夾即可。'),
    backupNote,
    h('table', { class: 'backup-list' }, backupBody));

  const aboutCard = h('div', { class: 'card' },
    h('h2', null, '關於'),
    h('p', null, `程式版本：${APP_VERSION}`),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => actions.checkUpdate() }, '檢查更新')),
    h('p', { class: 'muted small' }, `資料最後存檔時間：${store.data.savedAt ? fmtDateTime(store.data.savedAt) : '（尚無）'}`));

  container.replaceChildren(positionsCard, dataCard, aboutCard);
  renderRows();
  refreshBackups();
}
