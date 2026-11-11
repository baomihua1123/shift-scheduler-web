import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, analyze, seatKey } from '../js/engine.js';
import { buildDayLayout, parseHM, timeRangeLabel, timelinePositions, dateLabel, sheetName } from '../js/timeslots.js';

const rows = (layout) => layout.map((r) => [r.kind, timeRangeLabel(r.start, r.end), r.isMergedTail]);

test('班次切分：附圖例子的最後一班（剩 30 分 < 一半）併入上一班', () => {
  const layout = buildDayLayout(parseHM('07:30'), parseHM('20:00'), 90);
  const shifts = layout.filter((r) => r.kind === 'shift');
  assert.equal(shifts.length, 8);
  const last = shifts.at(-1);
  assert.equal(timeRangeLabel(last.start, last.end), '18:00~20:00');
  assert.equal(last.isMergedTail, true);
});

test('班次切分：剩餘時間等於或大於一半就單獨成一班', () => {
  const layout = buildDayLayout(parseHM('09:00'), parseHM('12:00'), 120);
  assert.deepEqual(rows(layout), [['shift', '09:00~11:00', false], ['shift', '11:00~12:00', false]]);
});

test('班次切分：休息前後各自切分，班次不跨越休息', () => {
  const layout = buildDayLayout(parseHM('09:00'), parseHM('18:00'), 120, [{ label: '午餐', start: parseHM('12:00'), end: parseHM('13:00') }]);
  assert.deepEqual(layout.map((r) => r.kind), ['shift', 'shift', 'break', 'shift', 'shift', 'shift']);
  assert.deepEqual([...new Set(layout.filter((r) => r.kind === 'shift').map((r) => r.segmentNo))], [0, 1]);
  const { tpos, length } = timelinePositions(layout);
  assert.deepEqual(tpos, [0, 1, 3, 4, 5]);
  assert.equal(length, 6);
});

test('班次切分：不合理的輸入會丟出清楚的錯誤', () => {
  assert.throws(() => buildDayLayout(600, 500, 60), /結束時間必須晚於開始時間/);
  assert.throws(() => buildDayLayout(540, 1080, 60, [{ label: 'x', start: 500, end: 560 }]), /超出工作時間範圍/);
  assert.throws(() => parseHM('9點'), /時間格式錯誤/);
  assert.equal(dateLabel('2026-11-07'), '11月07日');
  assert.equal(sheetName('2026-11-07'), '20261107');
});

function problem({ nSlots = 8, directors = 2, others = 10, avoid = true, dirAll = false } = {}) {
  const slots = Array.from({ length: nSlots }, (_, i) => ({ day: 0, tpos: i, label: `S${i + 1}` }));
  const positions = ['導播', 'OBS', '中特', '坤錄', '乾錄'].map((name, i) => ({ id: i + 1, name, headcount: 1, dedicated: null }));
  const staff = [];
  let id = 1;
  for (let i = 0; i < directors; i++) staff.push({ id: id++, name: `導${i + 1}`, qualified: new Set(dirAll ? [1, 2, 3, 4, 5] : [1]) });
  for (let i = 0; i < others; i++) staff.push({ id: id++, name: `員${i + 1}`, qualified: new Set([2, 3, 4, 5]) });
  return { slots, dayLengths: [nSlots], positions, staff, locked: {}, avoidConsecutive: avoid, dayLabels: ['11月07日'] };
}
const OPT = { seed: 7, timeLimit: 3 };

test('附圖情境：導播由兩人專任並 1 休 1，其他人每人 3~4 班且不連續', () => {
  for (const dirAll of [false, true]) {
    const p = problem({ dirAll });
    const r = solve(p, OPT);
    assert.equal(r.ok, true, r.errors.join(';'));
    const an = analyze(p, r.assignments);
    assert.deepEqual(an.errors, []);
    const byName = Object.fromEntries(p.staff.map((s) => [s.name, s.id]));
    for (const d of ['導1', '導2']) {
      assert.equal(an.counts[byName[d]], 4);
      assert.equal(an.maxRun[byName[d]], 1);
    }
    for (let i = 1; i <= 10; i++) assert.ok([3, 4].includes(an.counts[byName[`員${i}`]]), `員${i}=${an.counts[byName[`員${i}`]]}`);
    assert.ok(Object.values(an.maxRun).every((v) => v === 1));
    const names = Object.fromEntries(p.staff.map((s) => [s.id, s.name]));
    for (const [key, sid] of Object.entries(r.assignments)) {
      if (names[sid].startsWith('導')) assert.equal(Number(key.split('|')[1]), 1);
    }
  }
});

test('相同種子、單次重啟時結果可重現', () => {
  const o = { seed: 3, timeLimit: 3, restarts: 1, maxIters: 40000 };
  assert.deepEqual(solve(problem(), o).assignments, solve(problem(), o).assignments);
});

test('崗位沒有任何合格人員 → 清楚的錯誤', () => {
  const r = solve(problem({ directors: 0 }), OPT);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('導播')));
});

test('某班人數不足 → 失敗並說明', () => {
  const r = solve(problem({ directors: 1, others: 3 }), OPT);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('每班需要 2 人的崗位', () => {
  const p = problem({ directors: 0, others: 8 });
  p.positions = [{ id: 2, name: 'OBS', headcount: 2, dedicated: null }, { id: 3, name: '中特', headcount: 1, dedicated: null }];
  const r = solve(p, OPT);
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.deepEqual(analyze(p, r.assignments).errors, []);
  assert.equal(Object.keys(r.assignments).length, 8 * 3);
});

test('鎖定的座位會被保留', () => {
  const p = problem();
  p.locked = { [seatKey(0, 2, 0)]: 5 };
  const r = solve(p, OPT);
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.assignments[seatKey(0, 2, 0)], 5);
  assert.deepEqual(analyze(p, r.assignments).errors, []);
});

test('人力吃緊時給出提示', () => {
  const r = solve(problem({ directors: 1, others: 5 }), OPT);
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.ok(r.warnings.some((w) => /^本次人力吃緊，最長連續班次為 \d+ 班/.test(w)), r.warnings.join(' | '));
});

test('分析：偵測資格不符與漏排', () => {
  const p = problem({ nSlots: 2 });
  const r = solve(p, OPT);
  const bad = { ...r.assignments };
  bad[seatKey(0, 1, 0)] = 3; // 一般人員沒有導播資格
  delete bad[seatKey(1, 2, 0)];
  const an = analyze(p, bad);
  assert.ok(an.errors.some((e) => e.includes('不具備')));
  assert.ok(an.errors.some((e) => e.includes('尚未安排')));
});

test('休息前後不算連續上班', () => {
  const p = {
    slots: [{ day: 0, tpos: 0, label: 'a' }, { day: 0, tpos: 2, label: 'b' }], dayLengths: [3],
    positions: [{ id: 1, name: 'A', headcount: 1, dedicated: null }],
    staff: [{ id: 1, name: '甲', qualified: new Set([1]) }], locked: {}, avoidConsecutive: true,
  };
  const r = solve(p, OPT);
  assert.equal(analyze(p, r.assignments).maxRun[1], 1);
});

test('也能接受以陣列表示的資格（可跨 Worker 傳遞）', () => {
  const p = problem();
  p.staff = p.staff.map((s) => ({ ...s, qualified: [...s.qualified] }));
  assert.equal(solve(p, OPT).ok, true);
});
