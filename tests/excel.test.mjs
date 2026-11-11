import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { Store, ConflictError } from '../js/store.js';
import { solve } from '../js/engine.js';
import { newEventDraft, buildProblem, engineToAssignments, buildView, buildMeta, viewOf, analyzeEvent, assignmentKey, candidatesFor } from '../js/event-model.js';
import { exportSchedule, readEventWorkbook, exportStaff, readStaffWorkbook, DATA_SHEET, STATS_SHEET } from '../js/excel-io.js';
import { readXlsx, writeXlsx, StyleBook } from '../js/xlsx.js';
import { crc32, makeZip, readZip } from '../js/zip.js';

class MemoryStorage {
  constructor() { this.file = null; this.known = null; }
  async load() { if (!this.file) return null; this.known = this.file.revision; return JSON.parse(JSON.stringify(this.file)); }
  async save(d) { if (this.file && this.known !== null && this.file.revision !== this.known) throw new ConflictError(this.file); this.file = JSON.parse(JSON.stringify(d)); this.known = d.revision; }
}
async function seed() {
  const s = new Store(new MemoryStorage(), { debounceMs: 5 });
  await s.open();
  const pos = {};
  for (const n of ['導播', 'OBS/矩陣', '中特', '坤錄', '乾錄']) pos[n] = s.addPosition(n);
  const staff = {};
  for (const n of ['楊智森', '簡明宏']) staff[n] = s.addStaff({ name: n, positionIds: [pos['導播']] });
  for (const n of ['簡淑婷', '宋帛蓓', '陳右青', '陳佑如', '劉念彤', '李峻毅', '林易德', '蘇博群', '施錦慧', '穆郁蓁']) {
    staff[n] = s.addStaff({ name: n, positionIds: ['OBS/矩陣', '中特', '坤錄', '乾錄'].map((k) => pos[k]) });
  }
  return { s, pos, staff };
}
async function scheduled(w, days, extra = {}) {
  const d = newEventDraft('2026-11-07');
  Object.assign(d, { name: '測試活動', shiftMinutes: 90, ...extra });
  d.days = days || [{ date: '2026-11-07', start: '07:30', end: '20:00', breaks: [] }];
  d.positions = w.s.positions().map((p) => ({ positionId: p.id, headcount: 1, dedicated: null }));
  d.staffIds = w.s.staffList().map((x) => x.id);
  const id = w.s.saveEvent(d).id;
  const ctx = buildProblem(w.s, w.s.getEvent(id));
  w.s.applyGeneration(id, engineToAssignments(ctx, solve(ctx.problem, { seed: 4, timeLimit: 3 }).assignments));
  return id;
}

test('zip：寫入後可讀回；CRC 與壓縮檔（Python 產生）都能處理', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  const files = [{ name: 'a.txt', data: new TextEncoder().encode('哈囉') }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) }];
  const back = await readZip(makeZip(files));
  assert.deepEqual([...back.keys()], ['a.txt', 'dir/b.bin']);
  assert.equal(new TextDecoder().decode(back.get('a.txt')), '哈囉');
});

test('xlsx：寫入再讀回（含合併儲存格、隱藏工作表、特殊字元）', async () => {
  const sb = new StyleBook();
  const st = sb.add({ font: { name: '標楷體', size: 16 }, fill: 'EBF1DE', border: true });
  const bytes = writeXlsx([
    { name: '甲', cells: [{ r: 1, c: 1, v: 'A & B <x> "q"', s: st }, { r: 2, c: 3, v: 7 }, { r: 3, c: 1, v: '  前後空白 ' }], merges: ['A1:B1'] },
    { name: '_data', hidden: true, cells: [{ r: 1, c: 1, v: 'hi' }] },
  ], sb);
  const sheets = await readXlsx(bytes);
  assert.deepEqual(sheets.map((s) => [s.name, s.state]), [['甲', 'visible'], ['_data', 'hidden']]);
  assert.equal(sheets[0].get(1, 1), 'A & B <x> "q"');
  assert.equal(sheets[0].get(2, 3), 7);
  assert.equal(sheets[0].get(3, 1), '  前後空白 ');
  assert.deepEqual(sheets[0].merges, [{ r1: 1, c1: 1, r2: 1, c2: 2 }]);
});

test('手動換人、鎖定、清空；已定稿後不可修改', async () => {
  const w = await seed();
  const id = await scheduled(w);
  const ev = w.s.getEvent(id);
  const key = assignmentKey('2026-11-07', '09:00', w.pos['中特'], 0);
  const cands = candidatesFor(w.s, ev, w.pos['中特']);
  assert.equal(cands.length, 10); // 兩位導播沒有中特資格
  const other = cands.find((c) => c.id !== ev.assignments[key].staffId).id;
  w.s.setAssignment(id, key, other);
  assert.equal(w.s.getEvent(id).assignments[key].staffId, other);
  assert.equal(w.s.toggleLock(id, key), true);
  w.s.setAssignment(id, key, cands[0].id); // 換人時保留鎖定狀態
  assert.equal(w.s.getEvent(id).assignments[key].locked, true);
  w.s.setAssignment(id, key, null);
  assert.equal(w.s.getEvent(id).assignments[key], undefined);
  assert.throws(() => w.s.toggleLock(id, key), /無法鎖定/);

  // 手動修改後出現問題：同一人同時兩個崗位 → 分析抓得到
  const k2 = assignmentKey('2026-11-07', '09:00', w.pos['坤錄'], 0);
  w.s.setAssignment(id, k2, w.s.getEvent(id).assignments[assignmentKey('2026-11-07', '09:00', w.pos['乾錄'], 0)].staffId);
  const { an, bad } = analyzeEvent(w.s, w.s.getEvent(id));
  assert.ok(an.errors.some((e) => e.includes('同時被安排在兩個崗位')));
  assert.ok(bad.has(k2));
  assert.ok(an.errors.some((e) => e.includes('尚未安排'))); // 剛清空的格子
  assert.throws(() => w.s.finalizeEvent(id), /無法定稿/);
});

test('定稿：保存快照（之後改名不影響）、唯讀、可解除', async () => {
  const w = await seed();
  const id = await scheduled(w);
  w.s.finalizeEvent(id);
  const ev = w.s.getEvent(id);
  assert.equal(ev.status, 'final');
  assert.ok(ev.snapshot.view && ev.snapshot.meta);
  assert.throws(() => w.s.setAssignment(id, 'x|x|1|0', 1), /已定稿/);
  assert.throws(() => w.s.clearAssignments(id), /已定稿/);
  assert.throws(() => w.s.applyGeneration(id, {}), /已定稿/);
  w.s.updateStaff(w.staff['簡淑婷'], { name: '改名後', positionIds: w.s.getStaff(w.staff['簡淑婷']).positionIds, note: '' });
  const names = JSON.stringify(viewOf(w.s, ev));
  assert.ok(names.includes('簡淑婷') && !names.includes('改名後'));
  w.s.unfinalizeEvent(id);
  assert.equal(w.s.getEvent(id).status, 'scheduled');
  assert.equal(w.s.getEvent(id).snapshot, undefined);
  assert.ok(JSON.stringify(viewOf(w.s, w.s.getEvent(id))).includes('改名後'));
});

test('Excel 匯出版面：每天一個工作表、時間為列崗位為欄、統計表、隱藏資料', async () => {
  const w = await seed();
  const id = await scheduled(w, [
    { date: '2026-11-07', start: '09:00', end: '18:00', breaks: [{ label: '午餐', start: '12:00', end: '13:00' }] },
    { date: '2026-11-08', start: '09:00', end: '18:00', breaks: [{ label: '午餐', start: '12:00', end: '13:00' }] },
  ], { shiftMinutes: 120 });
  const ev = w.s.getEvent(id);
  const bytes = exportSchedule(buildView(w.s, ev), buildMeta(w.s, ev));
  writeFileSync('/tmp/export_test.xlsx', bytes);
  const sheets = await readXlsx(bytes);
  assert.deepEqual(sheets.map((s) => s.name), ['20261107', '20261108', STATS_SHEET, DATA_SHEET]);
  assert.equal(sheets[3].state, 'hidden');
  const day = sheets[0];
  assert.equal(day.get(1, 1), '11月07日');
  assert.deepEqual([2, 3, 4, 5, 6].map((c) => day.get(1, c)), ['導播', 'OBS/矩陣', '中特', '坤錄', '乾錄']);
  assert.equal(day.get(2, 1), '09:00~11:00');
  assert.ok([2, 3, 4, 5, 6].every((c) => day.get(2, c)));
  const breakRow = [2, 3, 4, 5, 6, 7].find((r) => day.get(r, 2) === '午餐');
  assert.equal(day.get(breakRow, 1), '12:00~13:00');
  assert.ok(day.merges.some((m) => m.r1 === breakRow && m.c1 === 2 && m.c2 === 6));
  const stats = sheets[2];
  assert.equal(stats.get(1, 1), '日期');
  assert.deepEqual([2, 3, 4].map((r) => stats.get(r, 1)), ['11月07日', '11月08日', '總計']);
  let total = 0;
  for (let c = 2; c <= stats.maxCol; c++) total += stats.get(4, c);
  assert.equal(total, 2 * 5 * 5); // 兩天 × 每天 5 班 × 5 個崗位
});

test('Excel 匯入：完整還原專案，且採用在 Excel 內手動修改的姓名', async () => {
  const w = await seed();
  const id = await scheduled(w);
  const ev = w.s.getEvent(id);
  const bytes = exportSchedule(buildView(w.s, ev), buildMeta(w.s, ev));

  // 模擬使用者在 Excel 內改了一格：用 xlsx 讀出、改、再寫回（以相同欄位重新輸出）
  const imp = await readEventWorkbook(bytes);
  assert.equal(imp.source, 'package');
  assert.equal(imp.assignments.length, 40);
  const r = w.s.importEvent(imp);
  assert.deepEqual(r.warnings, []);
  const copy = w.s.getEvent(r.id);
  assert.equal(copy.name, '測試活動 (2)');
  assert.equal(copy.status, 'scheduled');
  assert.deepEqual(Object.fromEntries(Object.entries(copy.assignments).map(([k, a]) => [k, a.staffId])),
    Object.fromEntries(Object.entries(ev.assignments).map(([k, a]) => [k, a.staffId])));
  assert.deepEqual(analyzeEvent(w.s, copy).an.errors, []);

  // 手動編輯可見工作表的姓名
  const sheets = await readXlsx(bytes);
  const sb = new StyleBook();
  const day = sheets[0];
  const cells = [];
  for (let rr = 1; rr <= day.maxRow; rr++) for (let c = 1; c <= day.maxCol; c++) {
    let v = day.get(rr, c);
    if (rr === 2 && c === 3) v = '劉念彤';
    if (v !== null) cells.push({ r: rr, c, v });
  }
  const data = sheets.find((s) => s.name === DATA_SHEET);
  const dcells = [];
  for (let rr = 1; rr <= data.maxRow; rr++) dcells.push({ r: rr, c: 1, v: data.get(rr, 1) });
  const edited = writeXlsx([{ name: '20261107', cells }, { name: DATA_SHEET, hidden: true, cells: dcells }], sb);
  const imp2 = await readEventWorkbook(edited);
  const hit = imp2.assignments.find((a) => a.start === '07:30' && a.position === 'OBS/矩陣');
  assert.equal(hit.staff, '劉念彤');
});

test('Excel 匯入：沒有隱藏資料的一般檔案，依版面盡力解析', async () => {
  const w = await seed();
  const id = await scheduled(w);
  const ev = w.s.getEvent(id);
  const sheets = await readXlsx(exportSchedule(buildView(w.s, ev), buildMeta(w.s, ev)));
  const day = sheets[0];
  const cells = [];
  for (let r = 1; r <= day.maxRow; r++) for (let c = 1; c <= day.maxCol; c++) if (day.get(r, c) !== null) cells.push({ r, c, v: day.get(r, c) });
  const plain = writeXlsx([{ name: '20261107', cells }, { name: '備註', cells: [{ r: 1, c: 1, v: '不是日期的工作表' }] }], new StyleBook());
  const imp = await readEventWorkbook(plain, '手動表');
  assert.equal(imp.source, 'layout');
  assert.equal(imp.meta.shiftMinutes, 90);
  assert.equal(imp.meta.days[0].end, '20:00');
  const r = w.s.importEvent(imp);
  const copy = w.s.getEvent(r.id);
  assert.equal(copy.name, '手動表');
  assert.equal(Object.keys(copy.assignments).length, 40);
  assert.deepEqual(analyzeEvent(w.s, copy).an.errors, []);
  await assert.rejects(readEventWorkbook(writeXlsx([{ name: '隨便', cells: [{ r: 1, c: 1, v: 'x' }] }], new StyleBook())), /找不到任何以日期/);
});

test('人員名單 Excel：匯出、匯入（新增、更新、自動新增崗位）', async () => {
  const w = await seed();
  const rows = w.s.staffList().map((s) => ({ name: s.name, positions: s.positionIds.map((id) => w.s.positionName(id)), note: s.note }));
  const back = await readStaffWorkbook(exportStaff(rows));
  assert.equal(back.length, 12);
  assert.deepEqual(back.find((r) => r.name === '楊智森').positions, ['導播']);
  const rep = w.s.importStaffRows([
    { name: '新同學', positions: ['導播', '新崗位'], note: '' },
    { name: '楊智森', positions: ['導播', '中特'], note: '' },
  ]);
  assert.equal(rep.added, 1);
  assert.equal(rep.updated, 1);
  assert.ok(w.s.positions().some((p) => p.name === '新崗位'));
  assert.equal(w.s.getStaff(w.staff['楊智森']).positionIds.length, 2);
  await assert.rejects(readStaffWorkbook(writeXlsx([{ name: 'x', cells: [{ r: 1, c: 1, v: '隨便' }] }], new StyleBook())), /找不到「姓名」欄位/);
});
