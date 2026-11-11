// 活動（專案）的資料規則：驗證、班次版面、轉成排班引擎的輸入、班表檢視與統計。
// 不依賴瀏覽器與 Store，可在 Node 測試。
import { buildDayLayout, parseHM, fmtHM, timelinePositions, dateLabel } from './timeslots.js';
import { seatKey, analyze } from './engine.js';

export const STATUS_LABELS = { draft: '草稿', scheduled: '已排班', final: '已定稿' };
export const DEDICATED_CHOICES = [
  { value: null, label: '自動判斷' },
  { value: true, label: '一律專任' },
  { value: false, label: '一律不專任' },
];

export const assignmentKey = (date, start, positionId, k) => `${date}|${start}|${positionId}|${k}`;

export function addDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function daysBetween(isoA, isoB) {
  const t = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(isoB) - t(isoA)) / 86400000);
}

export function newEventDraft(todayIso) {
  return {
    id: null, name: '', note: '', status: 'draft',
    shiftMinutes: 90, mergeThreshold: 0.5,
    days: [{ date: todayIso, start: '09:00', end: '18:00', breaks: [] }],
    positions: [], staffIds: [], assignments: {}, lastGeneration: null, copiedFrom: null,
  };
}

export function cloneEvent(ev) { return JSON.parse(JSON.stringify(ev)); }

export function dayLayout(ev, day) {
  const breaks = (day.breaks || []).map((b) => ({
    label: (b.label || '').trim() || '休息', start: parseHM(b.start), end: parseHM(b.end),
  }));
  return buildDayLayout(parseHM(day.start), parseHM(day.end), ev.shiftMinutes, breaks, ev.mergeThreshold ?? 0.5);
}

export function validateEvent(ev) {
  if (!String(ev.name || '').trim()) throw new Error('請輸入活動名稱');
  if (!(Number(ev.shiftMinutes) > 0)) throw new Error('班次時長必須大於 0 分鐘');
  if (!ev.days || !ev.days.length) throw new Error('請至少新增一個工作日');
  const seen = new Set();
  for (const d of ev.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '') || Number.isNaN(Date.parse(d.date))) throw new Error('請填寫每一天的日期');
    if (seen.has(d.date)) throw new Error(`工作日重複：${d.date}`);
    seen.add(d.date);
    try { dayLayout(ev, d); } catch (e) { throw new Error(`${dateLabel(d.date)}：${e.message}`); }
  }
  const pids = ev.positions.map((p) => p.positionId);
  if (new Set(pids).size !== pids.length) throw new Error('本次所需崗位有重複');
  for (const p of ev.positions) if (!(p.headcount >= 1)) throw new Error('每班所需人數必須至少 1 人');
}

// 班次版面有變就代表班次要重新切分（原有班表會失效）
export function layoutSignature(ev) {
  return JSON.stringify([
    ev.shiftMinutes, ev.mergeThreshold ?? 0.5,
    [...ev.days].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => [
      d.date, d.start, d.end,
      [...(d.breaks || [])].map((b) => [(b.label || '').trim() || '休息', b.start, b.end]).sort(),
    ]),
  ]);
}

export function sortedDays(ev) { return [...ev.days].sort((a, b) => (a.date < b.date ? -1 : 1)); }

// 把整場活動展開成「班次清單」（由前到後），並保留每天的完整版面（含休息）
export function eventLayout(ev) {
  const days = [];
  const slots = [];
  sortedDays(ev).forEach((day, dayIndex) => {
    const layout = dayLayout(ev, day);
    const { tpos, length } = timelinePositions(layout);
    const rows = [];
    let n = 0;
    for (const r of layout) {
      if (r.kind === 'break') { rows.push({ kind: 'break', start: fmtHM(r.start), end: fmtHM(r.end), label: r.label }); continue; }
      const slot = {
        kind: 'shift', date: day.date, dayIndex, tpos: tpos[n], start: fmtHM(r.start), end: fmtHM(r.end),
        label: `${fmtHM(r.start)}~${fmtHM(r.end)}`, segmentNo: r.segmentNo, isMergedTail: r.isMergedTail,
      };
      n += 1;
      rows.push(slot);
      slots.push(slot);
    }
    days.push({ date: day.date, rows, length });
  });
  return { days, slots };
}

/**
 * 轉成排班引擎的輸入。
 * @returns {{problem, slots, slotIndex: Map<string, number>}}
 */
export function buildProblem(store, ev, { includeLocked = true } = {}) {
  const { days, slots } = eventLayout(ev);
  const slotIndex = new Map(slots.map((s, i) => [`${s.date}|${s.start}`, i]));

  const order = new Map(store.positions({ includeInactive: true }).map((p, i) => [p.id, i]));
  const evPositions = [...ev.positions]
    .filter((p) => store.getPosition(p.positionId))
    .sort((a, b) => (order.get(a.positionId) ?? 0) - (order.get(b.positionId) ?? 0));
  const positions = evPositions.map((p) => ({
    id: p.positionId, name: store.getPosition(p.positionId).name, headcount: p.headcount,
    dedicated: p.dedicated === true ? true : p.dedicated === false ? false : null,
  }));
  const posIds = new Set(positions.map((p) => p.id));

  const staff = [];
  for (const sid of [...ev.staffIds].sort((a, b) => a - b)) {
    const st = store.getStaff(sid);
    if (!st) continue;
    staff.push({ id: st.id, name: st.name, qualified: new Set(st.positionIds.filter((pid) => posIds.has(pid))) });
  }
  const staffIds = new Set(staff.map((s) => s.id));

  const locked = {};
  if (includeLocked) {
    for (const [key, a] of Object.entries(ev.assignments || {})) {
      if (!a || !a.locked) continue;
      const [date, start, pid, k] = key.split('|');
      const si = slotIndex.get(`${date}|${start}`);
      if (si === undefined || !posIds.has(Number(pid)) || !staffIds.has(a.staffId)) continue;
      locked[seatKey(si, Number(pid), Number(k))] = a.staffId;
    }
  }
  const problem = {
    slots: slots.map((s) => ({ day: s.dayIndex, tpos: s.tpos, label: s.label })),
    dayLengths: days.map((d) => d.length),
    dayLabels: days.map((d) => dateLabel(d.date)),
    positions, staff, locked, avoidConsecutive: true, // 「盡量不連續執勤」固定啟用
  };
  return { problem, slots, slotIndex };
}

// 引擎結果（以班次索引為鍵）→ 活動的排班資料（以日期與時間為鍵）
export function engineToAssignments(ctx, engineAssignments) {
  const out = {};
  for (const [key, staffId] of Object.entries(engineAssignments)) {
    const [si, pid, k] = key.split('|').map(Number);
    const s = ctx.slots[si];
    out[assignmentKey(s.date, s.start, pid, k)] = staffId;
  }
  return out;
}

// 活動目前的排班 → 以班次索引為鍵（供 analyze 使用）
export function assignmentsToEngine(ctx, ev) {
  const out = {};
  for (const [key, a] of Object.entries(ev.assignments || {})) {
    const [date, start, pid, k] = key.split('|');
    const si = ctx.slotIndex.get(`${date}|${start}`);
    if (si !== undefined && a) out[seatKey(si, Number(pid), Number(k))] = a.staffId;
  }
  return out;
}

/** 班表檢視：每天每個時段、每個崗位座位上是誰 */
export function buildView(store, ev) {
  const { days } = eventLayout(ev);
  const order = new Map(store.positions({ includeInactive: true }).map((p, i) => [p.id, i]));
  const positions = [...ev.positions]
    .filter((p) => store.getPosition(p.positionId))
    .sort((a, b) => (order.get(a.positionId) ?? 0) - (order.get(b.positionId) ?? 0))
    .map((p) => ({ id: p.positionId, name: store.getPosition(p.positionId).name, headcount: p.headcount }));
  const viewDays = days.map((day) => ({
    date: day.date,
    rows: day.rows.map((r) => {
      if (r.kind === 'break') return r;
      const cells = {};
      for (const p of positions) {
        cells[p.id] = Array.from({ length: p.headcount }, (_, k) => {
          const a = (ev.assignments || {})[assignmentKey(day.date, r.start, p.id, k)];
          if (!a) return null;
          const st = store.getStaff(a.staffId);
          return { staffId: a.staffId, name: st ? st.name : '（已刪除）', locked: Boolean(a.locked) };
        });
      }
      return { ...r, cells };
    }),
  }));
  const staffOrder = [...ev.staffIds].sort((a, b) => a - b)
    .map((id) => store.getStaff(id)).filter(Boolean).map((s) => s.name);
  return { eventName: ev.name, positions, days: viewDays, staffOrder };
}

/** 人員班次統計：每人每天幾班、總計 */
export function viewStats(view) {
  const names = [...view.staffOrder];
  const dates = view.days.map((d) => d.date);
  const table = new Map();
  const touch = (n) => { if (!table.has(n)) { table.set(n, Object.fromEntries(dates.map((d) => [d, 0]))); if (!names.includes(n)) names.push(n); } };
  names.forEach(touch);
  for (const day of view.days) {
    for (const r of day.rows) {
      if (r.kind !== 'shift') continue;
      const who = new Set();
      for (const lst of Object.values(r.cells)) for (const c of lst) if (c) who.add(c.name);
      for (const n of who) { touch(n); table.get(n)[day.date] += 1; }
    }
  }
  return { names, dates, table };
}

/** 活動設定（寫入匯出檔的隱藏資料，匯入時可還原成專案） */
export function buildMeta(store, ev) {
  const order = new Map(store.positions({ includeInactive: true }).map((p, i) => [p.id, i]));
  const positions = [...ev.positions].filter((p) => store.getPosition(p.positionId))
    .sort((a, b) => (order.get(a.positionId) ?? 0) - (order.get(b.positionId) ?? 0))
    .map((p) => ({ name: store.getPosition(p.positionId).name, headcount: p.headcount, dedicated: p.dedicated ?? null }));
  const attendees = [...ev.staffIds].sort((a, b) => a - b).map((id) => store.getStaff(id)).filter(Boolean)
    .map((s) => ({ name: s.name, positions: s.positionIds.map((pid) => store.getPosition(pid)).filter(Boolean).map((p) => p.name) }));
  return {
    name: ev.name, note: ev.note || '', shiftMinutes: ev.shiftMinutes, mergeThreshold: ev.mergeThreshold ?? 0.5,
    days: sortedDays(ev).map((d) => ({ date: d.date, start: d.start, end: d.end, breaks: (d.breaks || []).map((b) => ({ label: b.label, start: b.start, end: b.end })) })),
    positions, attendees,
  };
}

/** 已定稿的活動使用快照（之後人員或崗位改名也不影響），否則使用即時資料 */
export function viewOf(store, ev) {
  return ev.status === 'final' && ev.snapshot ? ev.snapshot.view : buildView(store, ev);
}
export function metaOf(store, ev) {
  return ev.status === 'final' && ev.snapshot ? ev.snapshot.meta : buildMeta(store, ev);
}

/** 分析目前班表：硬性問題（errors）與提醒（warnings） */
export function analyzeEvent(store, ev) {
  const ctx = buildProblem(store, ev, { includeLocked: false });
  const an = analyze(ctx.problem, assignmentsToEngine(ctx, ev));
  const bad = new Set([...an.badKeys].map((key) => {
    const [si, pid, k] = key.split('|').map(Number);
    const s = ctx.slots[si];
    return assignmentKey(s.date, s.start, pid, k);
  }));
  return { ctx, an, bad };
}

/** 某崗位在這個活動中可以選的人員（出席者且具備該崗位資格） */
export function candidatesFor(store, ev, positionId) {
  return [...ev.staffIds].sort((a, b) => a - b).map((id) => store.getStaff(id))
    .filter((s) => s && s.positionIds.includes(positionId)).map((s) => ({ id: s.id, name: s.name }));
}
