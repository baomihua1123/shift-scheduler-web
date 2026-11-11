import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, ConflictError } from '../js/store.js';
import { solve, analyze } from '../js/engine.js';
import {
  newEventDraft, validateEvent, layoutSignature, buildProblem, engineToAssignments, assignmentsToEngine,
  buildView, viewStats, eventLayout, addDays, daysBetween, cloneEvent,
} from '../js/event-model.js';

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

function draftFor({ s, pos, staff }, extra = {}) {
  const d = newEventDraft('2026-11-07');
  Object.assign(d, { name: '測試活動', shiftMinutes: 90 }, extra);
  d.days = extra.days || [{ date: '2026-11-07', start: '07:30', end: '20:00', breaks: [] }];
  d.positions = s.positions().map((p) => ({ positionId: p.id, headcount: 1, dedicated: null }));
  d.staffIds = s.staffList().map((x) => x.id);
  return d;
}

test('日期工具', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-11-07', '2026-12-01'), 24);
});

test('活動驗證：名稱、日期、時間、休息', () => {
  const d = newEventDraft('2026-11-07');
  assert.throws(() => validateEvent(d), /請輸入活動名稱/);
  d.name = 'x';
  d.days = [];
  assert.throws(() => validateEvent(d), /至少新增一個工作日/);
  d.days = [{ date: '2026-11-07', start: '18:00', end: '09:00', breaks: [] }];
  assert.throws(() => validateEvent(d), /結束時間必須晚於開始時間/);
  d.days = [{ date: '2026-11-07', start: '09:00', end: '18:00', breaks: [{ label: '午餐', start: '08:00', end: '09:00' }, ] }];
  d.days[0].breaks[0].start = '07:00';
  assert.throws(() => validateEvent(d), /超出工作時間範圍/);
  d.days = [{ date: '2026-11-07', start: '09:00', end: '18:00', breaks: [] }, { date: '2026-11-07', start: '09:00', end: '18:00', breaks: [] }];
  assert.throws(() => validateEvent(d), /工作日重複/);
});

test('儲存活動、狀態、排序與預覽', async () => {
  const w = await seed();
  const { s } = w;
  const id = s.saveEvent(draftFor(w)).id;
  assert.equal(s.getEvent(id).status, 'draft');
  const later = s.saveEvent(draftFor(w, { name: '之後的活動', days: [{ date: '2026-12-20', start: '09:00', end: '12:00', breaks: [] }] })).id;
  assert.deepEqual(s.events().map((e) => e.id), [later, id]); // 日期較新的在前
  const d = cloneEvent(s.getEvent(id));
  assert.deepEqual(s.previewSaveEvent(d), { layoutChanged: false, hasAssignments: false });
  d.shiftMinutes = 60;
  assert.equal(s.previewSaveEvent(d).layoutChanged, true);
});

test('完整流程：建立活動 → 建問題 → 排班 → 套用 → 檢視與統計', async () => {
  const w = await seed();
  const { s } = w;
  const id = s.saveEvent(draftFor(w)).id;
  const ev = s.getEvent(id);
  const ctx = buildProblem(s, ev);
  assert.equal(ctx.slots.length, 8);
  assert.equal(ctx.slots.at(-1).label, '18:00~20:00');
  const r = solve(ctx.problem, { seed: 5, timeLimit: 3 });
  assert.equal(r.ok, true, r.errors.join(';'));
  s.applyGeneration(id, engineToAssignments(ctx, r.assignments), r);
  const ev2 = s.getEvent(id);
  assert.equal(ev2.status, 'scheduled');
  assert.equal(Object.keys(ev2.assignments).length, 8 * 5);

  const an = analyze(ctx.problem, assignmentsToEngine(ctx, ev2));
  assert.deepEqual(an.errors, []);

  const view = buildView(s, ev2);
  assert.equal(view.positions.length, 5);
  assert.equal(view.days[0].rows.length, 8);
  const row0 = view.days[0].rows[0];
  assert.ok(Object.values(row0.cells).every((c) => c[0] && c[0].name));
  const st = viewStats(view);
  const total = (n) => Object.values(st.table.get(n)).reduce((a, b) => a + b, 0);
  assert.equal(total('楊智森'), 4);
  assert.equal(total('簡明宏'), 4);
  assert.equal(st.names.reduce((a, n) => a + total(n), 0), 40);
});

test('版面改變會清除班表；只改人員會移除不再有效的排班', async () => {
  const w = await seed();
  const { s, staff } = w;
  const id = s.saveEvent(draftFor(w)).id;
  const ctx = buildProblem(s, s.getEvent(id));
  s.applyGeneration(id, engineToAssignments(ctx, solve(ctx.problem, { seed: 1, timeLimit: 3 }).assignments));
  const before = Object.keys(s.getEvent(id).assignments).length;

  const d = cloneEvent(s.getEvent(id));
  d.staffIds = d.staffIds.filter((x) => x !== staff['簡淑婷']);
  const info = s.saveEvent(d);
  assert.equal(info.layoutChanged, false);
  assert.ok(info.pruned > 0);
  assert.equal(Object.keys(s.getEvent(id).assignments).length, before - info.pruned);
  assert.equal(s.getEvent(id).status, 'scheduled');

  const d2 = cloneEvent(s.getEvent(id));
  d2.shiftMinutes = 60;
  const info2 = s.saveEvent(d2);
  assert.equal(info2.layoutChanged, true);
  assert.deepEqual(s.getEvent(id).assignments, {});
  assert.equal(s.getEvent(id).status, 'draft');
});

test('複製活動：保留設定、平移日期、不含班表', async () => {
  const w = await seed();
  const { s } = w;
  const id = s.saveEvent(draftFor(w, {
    days: [
      { date: '2026-11-07', start: '09:00', end: '18:00', breaks: [{ label: '午餐', start: '12:00', end: '13:00' }] },
      { date: '2026-11-08', start: '09:00', end: '18:00', breaks: [{ label: '午餐', start: '12:00', end: '13:00' }] },
    ],
  })).id;
  const ctx = buildProblem(s, s.getEvent(id));
  s.applyGeneration(id, engineToAssignments(ctx, solve(ctx.problem, { seed: 1, timeLimit: 3 }).assignments));
  const copy = s.getEvent(s.duplicateEvent(id, '下一場', '2026-12-01'));
  assert.deepEqual(copy.days.map((d) => d.date), ['2026-12-01', '2026-12-02']);
  assert.equal(copy.days[0].breaks[0].label, '午餐');
  assert.equal(copy.shiftMinutes, 90);
  assert.equal(copy.positions.length, 5);
  assert.deepEqual(copy.assignments, {});
  assert.equal(copy.status, 'draft');
  assert.equal(copy.copiedFrom, id);
});

test('已鎖定的格子在重新排班時保留；清除可選擇保留鎖定', async () => {
  const w = await seed();
  const { s, pos } = w;
  const id = s.saveEvent(draftFor(w)).id;
  let ctx = buildProblem(s, s.getEvent(id));
  s.applyGeneration(id, engineToAssignments(ctx, solve(ctx.problem, { seed: 1, timeLimit: 3 }).assignments));
  const key = `2026-11-07|07:30|${pos['中特']}|0`;
  const who = s.getEvent(id).assignments[key].staffId;
  s.getEvent(id).assignments[key].locked = true;
  ctx = buildProblem(s, s.getEvent(id));
  const r = solve(ctx.problem, { seed: 99, timeLimit: 3 });
  assert.equal(r.ok, true, r.errors.join(';'));
  s.applyGeneration(id, engineToAssignments(ctx, r.assignments));
  assert.deepEqual(s.getEvent(id).assignments[key], { staffId: who, locked: true });
  s.clearAssignments(id, true);
  assert.deepEqual(Object.keys(s.getEvent(id).assignments), [key]);
  s.clearAssignments(id, false);
  assert.equal(s.getEvent(id).status, 'draft');
});

test('活動使用中的人員與崗位，刪除時改為停用', async () => {
  const w = await seed();
  const { s, pos, staff } = w;
  const id = s.saveEvent(draftFor(w)).id;
  assert.equal(s.deletePosition(pos['乾錄']), 'deactivated');
  assert.equal(s.deleteStaff(staff['簡淑婷']), 'deactivated');
  assert.equal(s.getStaff(staff['簡淑婷']).active, false);
  // 停用後，歷史活動仍然能建出完整檢視（名稱還在）
  const view = buildView(s, s.getEvent(id));
  assert.ok(view.positions.some((p) => p.name === '乾錄'));
  assert.ok(view.staffOrder.includes('簡淑婷'));
});

test('版面：休息列與班次列', async () => {
  const w = await seed();
  const d = draftFor(w, { days: [{ date: '2026-11-07', start: '09:00', end: '18:00', breaks: [{ label: '午餐', start: '12:00', end: '13:00' }] }], shiftMinutes: 120 });
  const { days, slots } = eventLayout(d);
  assert.deepEqual(days[0].rows.map((r) => r.kind), ['shift', 'shift', 'break', 'shift', 'shift', 'shift']);
  assert.equal(slots.length, 5);
  assert.notEqual(layoutSignature(d), layoutSignature({ ...d, shiftMinutes: 60 }));
});

test('「盡量不連續執勤」固定啟用：活動沒有這個開關，建出的問題一律啟用', async () => {
  const w = await seed();
  const draft = draftFor(w);
  assert.equal('avoidConsecutive' in newEventDraft('2026-11-07'), false);
  const id = w.s.saveEvent(draft).id;
  assert.equal('avoidConsecutive' in w.s.getEvent(id), false);
  assert.equal(buildProblem(w.s, w.s.getEvent(id)).problem.avoidConsecutive, true);
  // 舊資料裡若殘留 avoidConsecutive:false，也會被忽略
  w.s.getEvent(id).avoidConsecutive = false;
  assert.equal(buildProblem(w.s, w.s.getEvent(id)).problem.avoidConsecutive, true);
});

test('人力吃緊時，排班後的提示文字', async () => {
  const w = await seed();
  const draft = draftFor(w);
  draft.staffIds = [w.staff['楊智森'], ...['簡淑婷', '宋帛蓓', '陳右青', '陳佑如', '劉念彤'].map((n) => w.staff[n])];
  const id = w.s.saveEvent(draft).id;
  const ctx = buildProblem(w.s, w.s.getEvent(id));
  const r = solve(ctx.problem, { seed: 2, timeLimit: 3 });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.ok(r.warnings.some((x) => x.startsWith('本次人力吃緊，最長連續班次為')), r.warnings.join(' | '));
});
