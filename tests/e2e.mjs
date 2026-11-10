// 以真正的 Chromium 瀏覽器測試：選資料夾、自動存檔、備份、衝突、還原、匯出入、離線開啟。
// 執行：node tests/e2e.mjs   （需要已安裝 playwright 與 Chromium）
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from './serve.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = await import('/opt/npm-tools/node_modules/playwright/index.mjs')); }

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shots = join(root, 'tests', 'shots');
mkdirSync(shots, { recursive: true });
const { server, port } = await startServer(root);
const url = `http://localhost:${port}/`;
const browser = await chromium.launch();
let passed = 0;
const step = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

// 讓「選擇資料夾」改用瀏覽器內建的私有資料夾（OPFS），行為與真實資料夾的 API 相同
const fakePicker = () => {
  window.showDirectoryPicker = async () => {
    const r = await navigator.storage.getDirectory();
    return r.getDirectoryHandle(window.__pickDir || 'data1', { create: true });
  };
  // 無頭瀏覽器讀回「存在 IndexedDB 的資料夾代碼」會讓瀏覽器當掉，所以測試改用 localStorage 記住資料夾名稱
  window.__shiftSchedulerTest = {
    handleStore: {
      get: async () => {
        const n = localStorage.getItem('__dir');
        if (!n) return null;
        const r = await navigator.storage.getDirectory();
        return r.getDirectoryHandle(n);
      },
      set: async (h) => localStorage.setItem('__dir', h.name),
      del: async () => localStorage.removeItem('__dir'),
    },
  };
};
const readOpfs = (page, path) => page.evaluate(async (p) => {
  const root = await navigator.storage.getDirectory();
  let dir = root; const parts = p.split('/');
  const file = parts.pop();
  for (const d of parts) dir = await dir.getDirectoryHandle(d);
  return (await (await dir.getFileHandle(file)).getFile()).text();
}, path);
const writeOpfs = (page, path, text) => page.evaluate(async ([p, t]) => {
  const root = await navigator.storage.getDirectory();
  let dir = root; const parts = p.split('/');
  const file = parts.pop();
  for (const d of parts) dir = await dir.getDirectoryHandle(d, { create: true });
  const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
  await w.write(t); await w.close();
}, [path, text]);
const listOpfs = (page, path) => page.evaluate(async (p) => {
  const root = await navigator.storage.getDirectory();
  let dir = root;
  try { for (const d of p.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(d); } catch { return []; }
  const out = []; for await (const [n] of dir.entries()) out.push(n); return out.sort();
}, path);

const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
await context.addInitScript(fakePicker);
const errors = [];
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

async function addPosition(name, note = '') {
  await page.getByRole('button', { name: '新增崗位' }).click();
  await page.locator('dialog input[type=text]').first().fill(name);
  if (note) await page.locator('dialog input[type=text]').nth(1).fill(note);
  await page.getByRole('button', { name: '儲存' }).click();
}
async function addStaff(name, positions) {
  await page.getByRole('button', { name: '新增人員' }).click();
  await page.locator('dialog input[type=text]').first().fill(name);
  for (const p of positions) await page.locator('dialog .checks label', { hasText: p }).locator('input').check();
  await page.getByRole('button', { name: '儲存' }).click();
}
const waitSaved = () => page.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('已自動存檔'));

console.log('第一階段：瀏覽器實測');

await step('第一次開啟顯示「選擇資料夾」引導', async () => {
  await page.goto(url);
  await page.getByText('歡迎使用短期活動排班系統').waitFor();
  await page.screenshot({ path: join(shots, '01-first-run.png') });
});

await step('選擇資料夾後進入主畫面並自動建立資料檔', async () => {
  await page.getByRole('button', { name: '選擇資料夾' }).click();
  await page.getByRole('button', { name: '設定', exact: true }).waitFor();
  await waitSaved();
  const data = JSON.parse(await readOpfs(page, 'data1/排班資料.json'));
  assert.equal(data.app, 'shift-scheduler');
});

await step('新增崗位、調整順序，並自動寫入資料夾', async () => {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await addPosition('導播', '主控');
  await addPosition('攝影');
  await addPosition('中特');
  await addPosition('坤錄');
  await page.getByRole('button', { name: '新增崗位' }).click();
  await page.locator('dialog input[type=text]').first().fill('導播');
  await page.getByRole('button', { name: '儲存' }).click();
  assert.match(await page.locator('dialog .dlg-error').innerText(), /請輸入|已有同名/); // 重複名稱被擋
  await page.getByRole('button', { name: '取消' }).click();
  await page.locator('tbody tr', { hasText: '坤錄' }).click();
  await page.getByRole('button', { name: '上移' }).click();
  await waitSaved();
  const data = JSON.parse(await readOpfs(page, 'data1/排班資料.json'));
  assert.deepEqual(data.positions.sort((a, b) => a.order - b.order).map((p) => p.name), ['導播', '攝影', '坤錄', '中特']);
  await page.screenshot({ path: join(shots, '02-settings.png') });
});

await step('新增與編輯人員（適用崗位複選）', async () => {
  await page.getByRole('button', { name: '人員管理' }).click();
  await addStaff('楊智森', ['導播']);
  await addStaff('簡淑婷', ['攝影', '中特', '坤錄']);
  await addStaff('宋帛蓓', ['攝影', '坤錄']);
  await page.locator('tbody tr', { hasText: '宋帛蓓' }).dblclick();
  await page.locator('dialog .checks label', { hasText: '中特' }).locator('input').check();
  await page.getByRole('button', { name: '儲存' }).click();
  await waitSaved();
  const data = JSON.parse(await readOpfs(page, 'data1/排班資料.json'));
  assert.equal(data.staff.length, 3);
  const s = data.staff.find((x) => x.name === '宋帛蓓');
  assert.equal(s.positionIds.length, 3);
  assert.equal(await page.locator('tbody tr', { hasText: '宋帛蓓' }).locator('.chip').count(), 3);
  await page.screenshot({ path: join(shots, '03-staff.png') });
});

await step('搜尋、刪除（直接刪除）與恢復', async () => {
  await page.getByPlaceholder('搜尋姓名或崗位').fill('簡');
  assert.equal(await page.locator('tbody tr').count(), 1);
  await page.getByPlaceholder('搜尋姓名或崗位').fill('');
  await page.locator('tbody tr', { hasText: '楊智森' }).click();
  await page.getByRole('button', { name: '刪除', exact: true }).click();
  await page.getByRole('button', { name: '刪除', exact: true }).last().click();
  await waitSaved();
  assert.equal(JSON.parse(await readOpfs(page, 'data1/排班資料.json')).staff.length, 2);
  await addStaff('楊智森', ['導播']);
  await waitSaved();
  assert.equal(JSON.parse(await readOpfs(page, 'data1/排班資料.json')).staff.length, 3);
});

await step('重新整理後資料仍在（資料夾已被記住，不用再選）', async () => {
  await page.reload();
  await page.getByRole('button', { name: '人員管理' }).waitFor();
  await page.getByRole('button', { name: '人員管理' }).click();
  await page.locator('tbody tr', { hasText: '簡淑婷' }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 3);
});

await step('每次開啟會自動備份；內容沒變就不重複備份', async () => {
  let backups = await listOpfs(page, 'data1/備份');
  assert.equal(backups.length, 1, `備份數 ${backups.length}`);
  await page.reload();
  await page.getByRole('button', { name: '設定', exact: true }).waitFor();
  assert.equal((await listOpfs(page, 'data1/備份')).length, 1);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('button', { name: '還原此備份' }).first().waitFor();
  await page.screenshot({ path: join(shots, '04-backups.png') });
  await page.getByRole('button', { name: '人員管理' }).click();
  await addStaff('臨時人員', []);
  await waitSaved();
  await page.reload();
  await page.getByRole('button', { name: '設定', exact: true }).waitFor();
  backups = await listOpfs(page, 'data1/備份');
  assert.equal(backups.length, 2);
});

await step('同時開兩個視窗會被擋下，避免互相覆蓋', async () => {
  const page2 = await context.newPage();
  await page2.goto(url);
  await page2.getByText('已經有另一個視窗在使用本程式').waitFor();
  await page2.close();
});

await step('資料夾內容被其他電腦更改時，顯示衝突並可重新載入', async () => {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const data = JSON.parse(await readOpfs(page, 'data1/排班資料.json'));
  data.revision += 10;
  data.positions.push({ id: 99, name: '外來崗位', note: '', active: true, order: 99 });
  data.seq.position = 99;
  await writeOpfs(page, 'data1/排班資料.json', JSON.stringify(data));
  await addPosition('我的新崗位');
  await page.locator('#save-status', { hasText: '已被更改' }).waitFor();
  await page.screenshot({ path: join(shots, '05-conflict.png') });
  await page.locator('#save-status').getByRole('button', { name: '處理' }).click();
  await page.getByRole('button', { name: '重新載入資料夾內容' }).click();
  await page.locator('tbody tr', { hasText: '外來崗位' }).waitFor();
  assert.equal(await page.locator('tbody tr', { hasText: '我的新崗位' }).count(), 0);
  await waitSaved();
});

await step('從備份還原', async () => {
  await page.getByRole('button', { name: '還原此備份' }).last().click();
  await page.getByRole('button', { name: '還原', exact: true }).click();
  await page.getByText('已還原完成。').waitFor();
  await page.getByRole('button', { name: '知道了' }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('tbody tr', { hasText: '外來崗位' }).count(), 0);
  assert.ok((await listOpfs(page, 'data1/備份')).some((n) => n.includes('還原前')));
});

await step('匯出完整資料檔、再匯入', async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '匯出完整資料（檔案）' }).click(),
  ]);
  assert.match(download.suggestedFilename(), /^排班資料匯出_\d{8}_\d{6}\.json$/);
  const path = join(shots, 'export.json');
  await download.saveAs(path);
  const exported = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(exported.staff.length >= 3);
  exported.staff = exported.staff.slice(0, 1);
  writeFileSync(path, JSON.stringify(exported));
  await page.locator('input[type=file]').setInputFiles(path);
  await page.getByRole('button', { name: '匯入', exact: true }).click();
  await page.getByText('已匯入完成。').waitFor();
  await page.getByRole('button', { name: '知道了' }).click();
  await waitSaved();
  assert.equal(JSON.parse(await readOpfs(page, 'data1/排班資料.json')).staff.length, 1);
});

await step('匯入不是本程式的檔案會被拒絕', async () => {
  const bad = join(shots, 'bad.json');
  writeFileSync(bad, JSON.stringify({ hello: 'world' }));
  await page.locator('input[type=file]').setInputFiles(bad);
  await page.getByText('這個檔案無法匯入').waitFor();
  await page.getByRole('button', { name: '知道了' }).click();
});

await step('PWA：已註冊 Service Worker，離線也能開啟並讀到資料', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
  assert.equal(manifest.display, 'standalone');
  // 等快取完成後再離線
  await page.waitForFunction(async () => (await caches.keys()).length > 0);
  await page.reload(); // 讓 SW 接管頁面
  await page.getByRole('button', { name: '設定', exact: true }).waitFor();
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: '人員管理' }).waitFor();
  await page.getByRole('button', { name: '人員管理' }).click();
  await page.locator('tbody tr').first().waitFor();
  await context.setOffline(false);
});

await step('資料損毀時，可用最新備份還原（壞檔會被另存）', async () => {
  await context.addInitScript(() => { /* 保持假 picker */ });
  await writeOpfs(page, 'data1/排班資料.json', '{這不是正確的JSON');
  await page.reload();
  await page.getByText('資料檔損毀').waitFor();
  await page.screenshot({ path: join(shots, '06-corrupt.png') });
  await page.getByRole('button', { name: '用最新的備份還原' }).click();
  await page.getByRole('button', { name: '人員管理' }).waitFor();
  assert.ok((await listOpfs(page, 'data1/備份')).some((n) => n.startsWith('損毀的資料檔')));
  JSON.parse(await readOpfs(page, 'data1/排班資料.json'));
});

await step('不支援的瀏覽器顯示提示', async () => {
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript(() => { delete window.showDirectoryPicker; });
  const p2 = await ctx2.newPage();
  await p2.goto(url);
  await p2.getByText('請改用 Chrome 或 Edge 開啟').waitFor();
  await ctx2.close();
});

await step('整個過程沒有任何瀏覽器錯誤', async () => {
  const real = errors.filter((e) => !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED/.test(e));
  assert.deepEqual(real, []);
});

await browser.close();
server.close();
console.log(`\n全部通過：${passed} 項`);
