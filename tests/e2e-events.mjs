// 第二階段瀏覽器實測：活動設定、自動排班（Web Worker）、班表檢視、複製活動、離線排班。
// 執行：LC_ALL=C.UTF-8 node tests/e2e-events.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from './serve.mjs';
import { emptyData } from '../js/store.js';

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

// 預先放好的資料：5 個崗位、12 位人員（2 位只會導播）
const seed = emptyData();
['導播', 'OBS/矩陣', '中特', '坤錄', '乾錄'].forEach((n, i) => seed.positions.push({ id: i + 1, name: n, note: '', active: true, order: i + 1 }));
seed.seq.position = 5;
const names = ['楊智森', '簡明宏', '簡淑婷', '宋帛蓓', '陳右青', '陳佑如', '劉念彤', '李峻毅', '林易德', '蘇博群', '施錦慧', '穆郁蓁'];
names.forEach((n, i) => seed.staff.push({ id: i + 1, name: n, note: '', active: true, positionIds: i < 2 ? [1] : [2, 3, 4, 5] }));
seed.seq.staff = 12;
seed.revision = 1;

const init = (seedJson) => {
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('data1', { create: true });
  window.__shiftSchedulerTest = {
    handleStore: {
      get: async () => {
        if (!localStorage.getItem('__dir')) return null;
        return (await navigator.storage.getDirectory()).getDirectoryHandle(localStorage.getItem('__dir'));
      },
      set: async (h) => localStorage.setItem('__dir', h.name),
      del: async () => localStorage.removeItem('__dir'),
    },
  };
  // 第一次載入前先放入測試資料並指定資料夾
  if (!localStorage.getItem('__seeded')) {
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('__dir', 'data1');
    window.__seedReady = (async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('data1', { create: true });
      const w = await (await dir.getFileHandle('排班資料.json', { create: true })).createWritable();
      await w.write(seedJson); await w.close();
    })();
  }
};

const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(init, JSON.stringify(seed));
// 讓 app 等到測試資料寫好再開始：覆寫 getFileHandle 之前先等待
await context.addInitScript(() => {
  const orig = navigator.locks && navigator.locks.request.bind(navigator.locks);
  if (orig) navigator.locks.request = async (...a) => { if (window.__seedReady) await window.__seedReady; return orig(...a); };
});
const errors = [];
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const readData = () => page.evaluate(async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('data1');
  return JSON.parse(await (await (await dir.getFileHandle('排班資料.json')).getFile()).text());
});
const waitSaved = () => page.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('已自動存檔'));
const dialogButton = (name) => page.locator('dialog').getByRole('button', { name, exact: true });

async function fillDay(i, { date, start, end }) {
  const row = page.locator('#days-table tbody tr').nth(i);
  if (date) await row.locator('input[type=date]').fill(date);
  if (start) await row.locator('input[type=time]').nth(0).fill(start);
  if (end) await row.locator('input[type=time]').nth(1).fill(end);
}
async function selectAllPositions() {
  const boxes = page.locator('#pos-table input[type=checkbox]');
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check();
}

console.log('第二階段：活動設定與自動排班');

await step('載入預先放好的人員與崗位', async () => {
  await page.goto(url);
  await page.getByRole('button', { name: '新增活動' }).waitFor();
  await page.getByRole('button', { name: '人員管理' }).click();
  assert.equal(await page.locator('tbody tr').count(), 12);
  await page.getByRole('button', { name: '活動專案' }).click();
});

await step('新增活動：填設定並產生班表（附圖情境：7:30~20:00、每班 90 分）', async () => {
  await page.getByRole('button', { name: '新增活動' }).click();
  await page.locator('#ev-name').fill('冒煙測試-單日');
  await page.locator('#ev-shift').fill('90');
  await fillDay(0, { date: '2026-11-07', start: '07:30', end: '20:00' });
  await selectAllPositions();
  await page.locator('#all-staff').click();
  await page.screenshot({ path: join(shots, '10-event-settings.png'), fullPage: true });
  await page.locator('#save-generate').click();
  await page.locator('#issues').waitFor({ timeout: 60000 }); // 排班完成後才會出現檢查結果
  assert.equal(await page.locator('#sched-table tbody tr').count(), 8);
  assert.equal(await page.locator('#sched-table thead th').first().innerText(), '11月07日');
  assert.deepEqual(await page.locator('#sched-table thead th').allInnerTexts(), ['11月07日', '導播', 'OBS/矩陣', '中特', '坤錄', '乾錄']);
  const last = await page.locator('#sched-table tbody tr').last().locator('td').first().innerText();
  assert.equal(last, '18:00~20:00'); // 最後 30 分併入上一班
  // 每格都有人
  const cells = await page.locator('#sched-table tbody td[data-pos]').allInnerTexts();
  assert.equal(cells.length, 40);
  assert.ok(cells.every((c) => c.trim().length > 0));
  await page.screenshot({ path: join(shots, '11-schedule.png'), fullPage: true });
});

await step('導播只由兩位導播擔任並 1 休 1；統計表與檢查結果正確', async () => {
  const directors = await page.locator('#sched-table td[data-pos="導播"]').allInnerTexts();
  assert.ok(directors.every((n) => ['楊智森', '簡明宏'].includes(n)));
  for (let i = 1; i < directors.length; i++) assert.notEqual(directors[i], directors[i - 1]);
  const header = await page.locator('#stats-table thead th').allInnerTexts();
  assert.equal(header[0], '日期');
  const totalRow = await page.locator('#stats-table tbody tr.total').locator('td').allInnerTexts();
  assert.equal(totalRow.reduce((a, b) => a + Number(b), 0), 40);
  assert.equal(Number(totalRow[header.indexOf('楊智森') - 1]), 4);
  assert.equal(await page.locator('#stats-table tbody tr').first().locator('th').innerText(), '11月07日');
  assert.match(await page.locator('#issues').innerText(), /所有班次與崗位都已排滿/);
  const data = await readData();
  const ev = data.events.at(-1);
  assert.equal(ev.status, 'scheduled');
  assert.equal(Object.keys(ev.assignments).length, 40);
});

await step('多天＋共同休息：休息列、每天一個分頁', async () => {
  await page.getByRole('button', { name: '新增活動' }).click();
  await page.locator('#ev-name').fill('冒煙測試-兩天');
  await page.locator('#ev-shift').fill('120');
  await fillDay(0, { date: '2026-12-05', start: '09:00', end: '18:00' });
  await page.locator('#add-day').click();
  assert.equal(await page.locator('#days-table tbody tr').count(), 2);
  assert.equal(await page.locator('#days-table tbody tr').nth(1).locator('input[type=date]').inputValue(), '2026-12-06');
  await page.locator('#ev-breaks').check();
  assert.equal(await page.locator('#breaks-table tbody tr').count(), 2);
  await selectAllPositions();
  await page.locator('#all-staff').click();
  await page.locator('#save-generate').click();
  await page.locator('#issues').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#sched-table tbody tr.break'));
  assert.equal(await page.locator('#sched-table tbody tr.break td').nth(1).innerText(), '午餐');
  assert.equal(await page.locator('#sched-table tbody tr.break td').first().innerText(), '12:00~13:00');
  assert.equal(await page.locator('.daytab').count(), 2);
  await page.locator('.daytab').nth(1).click();
  assert.equal(await page.locator('#sched-table thead th').first().innerText(), '12月06日');
  assert.equal(await page.locator('#stats-table tbody tr').count(), 3); // 兩天 + 總計
  await page.screenshot({ path: join(shots, '12-two-days.png'), fullPage: true });
  const ev = (await readData()).events.at(-1);
  assert.equal(ev.days[0].breaks[0].label, '午餐');
});

await step('修改班次時長會提醒並清除班表', async () => {
  await page.getByRole('button', { name: '活動設定' }).click();
  await page.locator('#ev-shift').fill('60');
  await page.locator('#save-event').click();
  await page.locator('dialog').getByText('目前的班表會被清除').waitFor();
  await dialogButton('取消').click();
  await page.locator('#save-event').click();
  await dialogButton('繼續儲存').click();
  await page.waitForFunction(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('data1');
    const d = JSON.parse(await (await (await dir.getFileHandle('排班資料.json')).getFile()).text());
    return d.events.at(-1).status === 'draft' && d.events.at(-1).shiftMinutes === 60;
  });
});

await step('複製活動：保留設定、日期平移、不含班表', async () => {
  await page.getByRole('button', { name: '複製設定' }).click();
  await page.locator('dialog input[type=text]').fill('下一場活動');
  await page.locator('dialog input[type=date]').fill('2027-01-10');
  await dialogButton('複製').click();
  await page.locator('#ev-name').waitFor();
  assert.equal(await page.locator('#ev-name').inputValue(), '下一場活動');
  assert.equal(await page.locator('#days-table tbody tr').nth(0).locator('input[type=date]').inputValue(), '2027-01-10');
  assert.equal(await page.locator('#days-table tbody tr').nth(1).locator('input[type=date]').inputValue(), '2027-01-11');
  assert.equal(await page.locator('#breaks-table tbody tr').count(), 2);
  assert.equal(await page.locator('#ev-shift').inputValue(), '60');
  assert.equal(await page.locator('#attendees input:checked').count(), 12);
  await page.screenshot({ path: join(shots, '13-copied.png'), fullPage: true });
});

await step('人員不足時給出清楚的錯誤（沒有人會導播）', async () => {
  const boxes = page.locator('#attendees label');
  for (const n of ['楊智森', '簡明宏']) await boxes.filter({ hasText: n }).locator('input').uncheck();
  await page.locator('#save-generate').click();
  await page.locator('dialog').getByText('導播').waitFor();
  assert.match(await page.locator('dialog').innerText(), /每班需要 1 人，但本次出席人員中具備資格的只有 0 人/);
  await dialogButton('知道了').click();
});

await step('未儲存就切換活動會先詢問', async () => {
  await page.locator('#ev-name').fill('改到一半還沒存');
  await page.locator('.event-item', { hasText: '冒煙測試-單日' }).click();
  await page.locator('dialog').getByText('還沒有儲存').waitFor();
  await dialogButton('取消').click();
  await page.locator('.event-item', { hasText: '冒煙測試-單日' }).click();
  await dialogButton('放棄修改').click();
  await page.locator('#sched-table').waitFor();
});

await step('重新整理後活動與班表仍在', async () => {
  await page.reload();
  await page.locator('.event-item', { hasText: '冒煙測試-兩天' }).waitFor();
  await page.locator('.event-item', { hasText: '冒煙測試-單日' }).click();
  await page.locator('#sched-table').waitFor();
  assert.equal(await page.locator('#sched-table tbody tr').count(), 8);
});

await step('離線也能重新排班（Worker 與引擎都已快取）', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).length > 0);
  await page.reload(); // 讓 SW 接管
  await page.locator('.event-item', { hasText: '冒煙測試-單日' }).waitFor();
  await context.setOffline(true);
  await page.reload();
  await page.locator('.event-item', { hasText: '冒煙測試-單日' }).click();
  await page.locator('#gen-btn').click();
  await page.locator('#gen-btn', { hasText: '重新排班' }).waitFor({ timeout: 60000 });
  await page.locator('#issues').waitFor();
  await context.setOffline(false);
});

await step('刪除活動', async () => {
  await page.locator('.event-item', { hasText: '冒煙測試-單日' }).click();
  await page.getByRole('button', { name: '刪除', exact: true }).first().click();
  await dialogButton('刪除').click();
  await page.waitForFunction(() => !document.body.innerText.includes('冒煙測試-單日'));
  await waitSaved();
  assert.equal((await readData()).events.some((e) => e.name === '冒煙測試-單日'), false);
});

await step('整個過程沒有任何瀏覽器錯誤', async () => {
  const real = errors.filter((e) => !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED/.test(e));
  assert.deepEqual(real, []);
});

await browser.close();
server.close();
console.log(`\n全部通過：${passed} 項`);
