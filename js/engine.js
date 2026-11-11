// 排班引擎（純 JavaScript，對應桌面版的 engine.py；不碰資料庫與畫面，可在 Web Worker 或 Node 執行）。
//
// 排班目標（由高到低）：
// 1. 硬性：每個班次、每個崗位、每個名額都有人；人員須具備該崗位資格；同一人同一班次只在一個崗位。
// 2. 班次數公平：每人輪到的班次盡量接近。
// 3. 休息分佈：盡量 1 休 1，避免連續多班；共同休息與跨天視為已休息。
// 4. 稀缺崗位專任：合格人數稀少的崗位，由這些人專任，不進入其他崗位的輪替，兩組各自計算公平性。
//
// 做法：先拆成互不重疊的「組」，每組以模擬退火決定「每個班次由哪些人上班」，
// 再用匈牙利演算法把人員分配到各崗位座位（盡量讓同一人輪不同崗位）。

const W_COUNT = 400;
const W_DAY = 15;
const W_RUN = 60;
const W_GAP = 8;

export const seatKey = (si, pid, k) => `${si}|${pid}|${k}`;
const parseSeat = (key) => key.split('|').map(Number);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const seatText = (pos, k) => (pos.headcount > 1 ? `第${k + 1}位` : '');
const dayLabelOf = (problem, d) => (problem.dayLabels && problem.dayLabels[d]) || `第${d + 1}天`;
const toSet = (x) => (x instanceof Set ? x : new Set(x || []));

// ---------------------------------------------------------------- 小工具
// 座位對人員的完美配對（Kuhn）。失敗時回傳 info = { seats:Set, persons:Set }（Hall 違反集合）
function perfectMatch(seatPos, persons, qual) {
  const n = seatPos.length;
  const adj = seatPos.map((pos) => persons.filter((p) => qual.get(pos).has(p)));
  const matchP = new Map();
  function trySeat(u, seen) {
    for (const p of adj[u]) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (!matchP.has(p) || trySeat(matchP.get(p), seen)) { matchP.set(p, u); return true; }
    }
    return false;
  }
  for (let u = 0; u < n; u++) {
    const seen = new Set();
    if (!trySeat(u, seen)) {
      const seats = new Set([u]);
      for (const p of seen) if (matchP.has(p)) seats.add(matchP.get(p));
      return { match: null, info: { seats, persons: seen } };
    }
  }
  const match = new Array(n).fill(-1);
  for (const [p, u] of matchP) match[u] = p;
  return { match, info: null };
}

// 方陣最小成本指派；回傳 row -> col
function hungarian(cost) {
  const n = cost.length;
  const INF = Infinity;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const ans = new Array(n).fill(0);
  for (let j = 1; j <= n; j++) ans[p[j] - 1] = j - 1;
  return ans;
}

// ---------------------------------------------------------------- 驗證與分析
/**
 * 檢查一份班表：硬性違規列為 errors，軟性問題列為 warnings。
 * @param problem 見 solve()
 * @param assignments { 'si|pid|k': staffId }
 */
export function analyze(problem, assignments) {
  const staffById = new Map(problem.staff.map((s) => [s.id, { ...s, qualified: toSet(s.qualified) }]));
  const res = { errors: [], warnings: [], counts: {}, dayCounts: {}, maxRun: {}, badKeys: new Set() };
  const works = new Map();

  problem.slots.forEach((slot, si) => {
    const seen = new Map();
    for (const pos of problem.positions) {
      for (let k = 0; k < pos.headcount; k++) {
        const key = seatKey(si, pos.id, k);
        const sid = assignments[key];
        const where = `${dayLabelOf(problem, slot.day)} ${slot.label}「${pos.name}」${seatText(pos, k)}`;
        if (sid === undefined || sid === null) {
          res.errors.push(`${where} 尚未安排人員`); res.badKeys.add(key); continue;
        }
        const st = staffById.get(sid);
        if (!st) { res.errors.push(`${where} 的人員不是本次出席人員`); res.badKeys.add(key); continue; }
        if (!st.qualified.has(pos.id)) { res.errors.push(`${where}：${st.name} 不具備此崗位資格`); res.badKeys.add(key); }
        if (seen.has(sid)) {
          res.errors.push(`${dayLabelOf(problem, slot.day)} ${slot.label}：${st.name} 同時被安排在兩個崗位`);
          res.badKeys.add(key); res.badKeys.add(seen.get(sid));
        } else {
          seen.set(sid, key);
          if (!works.has(sid)) works.set(sid, []);
          works.get(sid).push(si);
        }
      }
    }
  });

  for (const st of problem.staff) {
    const worked = [...new Set(works.get(st.id) || [])].sort((a, b) => a - b);
    res.counts[st.id] = worked.length;
    const perDay = {};
    const byDay = new Map();
    for (const si of worked) {
      const sl = problem.slots[si];
      perDay[sl.day] = (perDay[sl.day] || 0) + 1;
      if (!byDay.has(sl.day)) byDay.set(sl.day, []);
      byDay.get(sl.day).push(sl.tpos);
    }
    res.dayCounts[st.id] = perDay;
    let longest = 0;
    for (const [d, tps] of byDay) {
      tps.sort((a, b) => a - b);
      let run = 1; let best = 1;
      for (let i = 1; i < tps.length; i++) {
        run = tps[i] === tps[i - 1] + 1 ? run + 1 : 1;
        best = Math.max(best, run);
      }
      longest = Math.max(longest, best);
      if (problem.avoidConsecutive && best >= 3) res.warnings.push(`${st.name} 在 ${dayLabelOf(problem, d)} 連續上 ${best} 班`);
    }
    res.maxRun[st.id] = longest;
  }
  return res;
}

function validateProblem(problem) {
  const errs = [];
  if (!problem.slots.length) errs.push('沒有任何班次可排，請確認工作日期與時間設定');
  if (!problem.positions.length) errs.push('尚未選擇本次所需崗位');
  if (!problem.staff.length) errs.push('尚未選擇本次出席人員');
  if (errs.length) return errs;
  for (const pos of problem.positions) {
    if (pos.headcount < 1) errs.push(`崗位「${pos.name}」每班人數必須至少 1 人`);
  }
  const staffById = new Map(problem.staff.map((s) => [s.id, s]));
  const posById = new Map(problem.positions.map((p) => [p.id, p]));
  for (const pos of problem.positions) {
    const q = problem.staff.filter((s) => s.qualified.has(pos.id)).length;
    if (q < pos.headcount) errs.push(`崗位「${pos.name}」每班需要 ${pos.headcount} 人，但本次出席人員中具備資格的只有 ${q} 人`);
  }
  const seatOfPerson = new Set();
  for (const [key, sid] of Object.entries(problem.locked || {})) {
    const [si, pid, k] = parseSeat(key);
    if (!(si >= 0 && si < problem.slots.length) || !posById.has(pid) || !(k >= 0 && k < posById.get(pid).headcount)) {
      errs.push('存在無效的鎖定座位，請清除班表後重試'); continue;
    }
    const st = staffById.get(sid);
    if (!st) { errs.push(`鎖定的人員不是本次出席人員（${problem.slots[si].label}）`); continue; }
    if (!st.qualified.has(pid)) errs.push(`鎖定的安排有誤：${st.name} 不具備「${posById.get(pid).name}」資格`);
    if (seatOfPerson.has(`${si}|${sid}`)) errs.push(`${problem.slots[si].label}：${st.name} 被鎖定在兩個崗位`);
    seatOfPerson.add(`${si}|${sid}`);
  }
  return errs;
}

// ---------------------------------------------------------------- 分組（專任 / 一般）
function chooseDedicated(problem, qualCount, notes) {
  const forced = new Set(problem.positions.filter((p) => p.dedicated === true).map((p) => p.id));
  const auto = new Set(problem.positions
    .filter((p) => (p.dedicated === null || p.dedicated === undefined) && qualCount.get(p.id) <= p.headcount + 1)
    .map((p) => p.id));
  const chosen = new Set([...forced, ...auto]);
  if (!auto.size || chosen.size === problem.positions.length) return chosen;

  // 自動判定的專任，不可讓一般崗位的人力過緊（至少要比每班所需人數多 1 人才有得休息）
  const dedStaff = new Set();
  problem.staff.forEach((s, i) => { if ([...chosen].some((pid) => s.qualified.has(pid))) dedStaff.add(i); });
  const restPos = problem.positions.filter((p) => !chosen.has(p.id));
  const seats = restPos.reduce((a, p) => a + p.headcount, 0);
  const restStaff = problem.staff.filter((s, i) => !dedStaff.has(i) && restPos.some((p) => s.qualified.has(p.id)));
  if (restStaff.length < seats + 1) {
    notes.push('依合格人數判定的專任崗位會讓其他崗位人力過緊，已改為不專任，所有人共同輪替。');
    return forced;
  }
  return chosen;
}

function makeGroups(problem, dedicated) {
  const allPos = problem.positions.map((p) => p.id);
  const idx = (pred) => problem.staff.map((s, i) => (pred(s, i) ? i : -1)).filter((i) => i >= 0);
  if (!dedicated.size || dedicated.size === allPos.length) {
    return [{ name: '全部崗位', posIds: allPos, staffIdx: idx((s) => allPos.some((pid) => s.qualified.has(pid))) }];
  }
  const dedPos = allPos.filter((pid) => dedicated.has(pid));
  const restPos = allPos.filter((pid) => !dedicated.has(pid));
  const dStaff = idx((s) => dedPos.some((pid) => s.qualified.has(pid)));
  const dSet = new Set(dStaff);
  const rStaff = idx((s, i) => !dSet.has(i) && restPos.some((pid) => s.qualified.has(pid)));
  return [
    { name: '專任組', posIds: dedPos, staffIdx: dStaff },
    { name: '一般組', posIds: restPos, staffIdx: rStaff },
  ];
}

// ---------------------------------------------------------------- 主求解
/**
 * @param problem {
 *   slots: {day:number, tpos:number, label:string}[],
 *   dayLengths: number[], dayLabels?: string[],
 *   positions: {id, name, headcount, dedicated: true|false|null}[],
 *   staff: {id, name, qualified: Set|Array}[],
 *   locked: { 'si|pid|k': staffId }, avoidConsecutive: boolean }
 * @param options { timeLimit(秒), maxIters, restarts, seed }
 * @returns {{ok:boolean, assignments:Object, errors:string[], warnings:string[], notes:string[]}}
 */
export function solve(problemIn, optionsIn = {}) {
  const options = { timeLimit: 6, maxIters: 250000, restarts: 3, seed: null, ...optionsIn };
  const problem = {
    ...problemIn,
    locked: problemIn.locked || {},
    staff: problemIn.staff.map((s) => ({ ...s, qualified: toSet(s.qualified) })),
  };
  const rand = mulberry32(options.seed === null || options.seed === undefined ? Math.floor(Math.random() * 2 ** 32) : options.seed);
  const res = { ok: false, assignments: {}, errors: [], warnings: [], notes: [] };

  const errs = validateProblem(problem);
  if (errs.length) { res.errors = errs; return res; }

  const posById = new Map(problem.positions.map((p) => [p.id, p]));
  const sidx = new Map(problem.staff.map((s, i) => [s.id, i]));
  const qual = new Map(problem.positions.map((p) => [p.id,
    new Set(problem.staff.map((s, i) => (s.qualified.has(p.id) ? i : -1)).filter((i) => i >= 0))]));
  const qualCount = new Map([...qual].map(([pid, set]) => [pid, set.size]));
  const S = problem.slots.length;

  const lockedSeats = new Map(Object.entries(problem.locked).map(([k, sid]) => [k, sidx.get(sid)]));
  const pinned = Array.from({ length: S }, () => new Set());
  for (const [key, i] of lockedSeats) pinned[parseSeat(key)[0]].add(i);

  const dedicated = chooseDedicated(problem, qualCount, res.notes);
  let groups = makeGroups(problem, dedicated);

  const freeSeatPos = (g, si) => {
    const out = [];
    for (const pid of g.posIds) {
      for (let k = 0; k < posById.get(pid).headcount; k++) if (!lockedSeats.has(seatKey(si, pid, k))) out.push(pid);
    }
    return out;
  };

  function feasibility(gs) {
    const out = [];
    for (const g of gs) {
      for (let si = 0; si < S; si++) {
        const seatPos = freeSeatPos(g, si);
        const pool = g.staffIdx.filter((i) => !pinned[si].has(i));
        const { info } = perfectMatch(seatPos, pool, qual);
        if (info) {
          const names = [...new Set([...info.seats].map((u) => posById.get(seatPos[u]).name))].sort();
          const slot = problem.slots[si];
          out.push(`${dayLabelOf(problem, slot.day)} ${slot.label}：崗位「${names.join('、')}」合計需要 ${info.seats.size} 人，` +
            `但可安排且具備資格的人員只有 ${info.persons.size} 位，無法補滿`);
          break;
        }
      }
    }
    return out;
  }

  let ferrs = feasibility(groups);
  if (ferrs.length && groups.length > 1) {
    res.warnings.push('專任規則在本次人力配置下無法排出完整班表，已放寬為所有人共同輪替各崗位。');
    const allPos = problem.positions.map((p) => p.id);
    groups = [{
      name: '全部崗位', posIds: allPos,
      staffIdx: problem.staff.map((s, i) => (allPos.some((pid) => s.qualified.has(pid)) ? i : -1)).filter((i) => i >= 0),
    }];
    ferrs = feasibility(groups);
  }
  if (ferrs.length) { res.errors = ferrs; return res; }

  if (groups.length > 1) {
    for (const g of groups) {
      res.notes.push(`${g.name}（${g.posIds.map((pid) => posById.get(pid).name).join('、')}）：` +
        `${g.staffIdx.map((i) => problem.staff[i].name).join('、')}`);
    }
  }
  const grouped = new Set(groups.flatMap((g) => g.staffIdx));
  const idle = problem.staff.filter((_s, i) => !grouped.has(i)).map((s) => s.name);
  if (idle.length) res.warnings.push(`以下人員沒有任何本次所需崗位的資格，不會被排班：${idle.join('、')}`);

  // 工作矩陣：W[i][s] = 1 表示人員 i 在班次 s 上班
  const W = problem.staff.map(() => new Uint8Array(S));
  for (const [key, i] of lockedSeats) W[i][parseSeat(key)[0]] = 1;
  const pinnedBase = W.map((w) => Uint8Array.from(w));

  const deadline = now() + Math.max(0.5, options.timeLimit) * 1000;
  const curAll = [];
  groups.forEach((g, gi) => {
    const share = (deadline - now()) / (groups.length - gi);
    curAll.push(solveGroup(problem, g, W, pinnedBase, lockedSeats, pinned, qual, posById, rand, options, now() + share, freeSeatPos));
  });

  // 把人員分配到座位
  const assignments = {};
  const poscount = new Map();
  const lastPos = new Map();
  const pc = (i, pid) => poscount.get(`${i}|${pid}`) || 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const cur = curAll[gi];
    for (let si = 0; si < S; si++) {
      const freeSeats = [];
      for (const pid of g.posIds) {
        for (let k = 0; k < posById.get(pid).headcount; k++) if (!lockedSeats.has(seatKey(si, pid, k))) freeSeats.push([pid, k]);
      }
      const persons = cur[si];
      if (persons.length !== freeSeats.length) { res.errors.push('內部錯誤：班次人數與座位數不一致'); return res; }
      if (!freeSeats.length) continue;
      const BIG = 1e6;
      const cost = persons.map((i) => freeSeats.map(([pid]) => {
        if (!problem.staff[i].qualified.has(pid)) return BIG;
        let c = 10 * pc(i, pid);
        if (lastPos.get(`${i}|${si - 1}`) === pid) c += 4;
        return c + rand();
      }));
      const ans = hungarian(cost);
      for (let r = 0; r < ans.length; r++) {
        const i = persons[r];
        const [pid, k] = freeSeats[ans[r]];
        if (cost[r][ans[r]] >= BIG) { res.errors.push('內部錯誤：座位配對失敗'); return res; }
        assignments[seatKey(si, pid, k)] = problem.staff[i].id;
        poscount.set(`${i}|${pid}`, pc(i, pid) + 1);
        lastPos.set(`${i}|${si}`, pid);
      }
    }
  }
  for (const [key, sid] of Object.entries(problem.locked)) assignments[key] = sid;

  res.assignments = assignments;
  res.ok = true;

  // 事後分析與提示
  const an = analyze(problem, assignments);
  res.warnings.push(...an.warnings);
  for (const g of groups) {
    const members = g.staffIdx.map((i) => problem.staff[i]);
    if (!members.length) continue;
    const cs = members.map((m) => an.counts[m.id]);
    if (Math.max(...cs) - Math.min(...cs) > 1) {
      res.warnings.push(`${g.name}班次數差距較大（最多 ${Math.max(...cs)} 班、最少 ${Math.min(...cs)} 班），多半是部分人員的崗位資格有限所致。`);
    }
    const seatsPerSlot = g.posIds.reduce((a, pid) => a + posById.get(pid).headcount, 0);
    const longest = Math.max(...members.map((m) => an.maxRun[m.id]));
    if (problem.avoidConsecutive && longest >= 2) {
      if (members.length < 2 * seatsPerSlot) {
        res.warnings.push(`本次人力吃緊，最長連續班次為 ${longest} 班（每班需${seatsPerSlot}人，只有${members.length}人可輪替）。`);
      } else if (longest >= 3) {
        res.warnings.push(`${g.name}仍有連續 ${longest} 班的情形，可再按一次「重新排班」。`);
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------- 單一組別：模擬退火
function solveGroup(problem, g, W, pinnedBase, lockedSeats, pinned, qual, posById, rand, options, deadline, freeSeatPos) {
  const S = problem.slots.length;
  const P = [...g.staffIdx];
  const runW = problem.avoidConsecutive ? W_RUN : 0;
  const gapW = problem.avoidConsecutive ? W_GAP : 0;

  const seatPos = [];
  for (let si = 0; si < S; si++) seatPos.push(freeSeatPos(g, si));
  const sigIds = new Map();
  const sigOf = seatPos.map((sp) => {
    const sig = [...sp].sort((a, b) => a - b).join(',');
    if (!sigIds.has(sig)) sigIds.set(sig, sigIds.size);
    return sigIds.get(sig);
  });

  const personPos = new Map(P.map((i) => [i, new Set(g.posIds.filter((pid) => qual.get(pid).has(i)))]));
  const elig = [];
  const eligSet = [];
  for (let si = 0; si < S; si++) {
    const ps = new Set(seatPos[si]);
    const lst = P.filter((i) => !pinned[si].has(i) && [...personPos.get(i)].some((pid) => ps.has(pid)));
    elig.push(lst);
    eligSet.push(new Set(lst));
  }
  const nAt = seatPos.map((sp) => sp.length);
  const movable = [];
  for (let si = 0; si < S; si++) if (nAt[si] > 0) movable.push(si);

  const daySlots = new Map();
  problem.slots.forEach((sl, si) => {
    if (!daySlots.has(sl.day)) daySlots.set(sl.day, []);
    daySlots.get(sl.day).push([si, sl.tpos]);
  });
  const dayKeys = [...daySlots.keys()];
  const slotDay = problem.slots.map((sl) => sl.day);
  const prevAdj = new Array(S).fill(null);
  for (let si = 1; si < S; si++) {
    const a = problem.slots[si - 1]; const b = problem.slots[si];
    if (a.day === b.day && a.tpos + 1 === b.tpos) prevAdj[si] = si - 1;
  }

  function dayCost(i, d) {
    const Wi = W[i];
    let run = 0; let lastT = null; let n = 0; let c = 0;
    for (const [si, t] of daySlots.get(d)) {
      if (Wi[si]) {
        n += 1;
        if (lastT !== null) {
          const gap = t - lastT - 1;
          if (gap === 0) run += 1;
          else {
            c += run * run * runW;
            run = 0;
            if (gap >= 2) c += (gap - 1) * (gap - 1) * gapW;
          }
        }
        lastT = t;
      }
    }
    c += run * run * runW;
    c += n * n * W_DAY;
    return c;
  }

  const feasCache = new Map();
  function feasible(si, persons) {
    const key = `${sigOf[si]}:${[...persons].sort((a, b) => a - b).join(',')}`;
    let v = feasCache.get(key);
    if (v === undefined) { v = perfectMatch(seatPos[si], persons, qual).match !== null; feasCache.set(key, v); }
    return v;
  }

  function totalCost(cnt) {
    let c = 0;
    for (const i of P) {
      c += W_COUNT * cnt[i] * cnt[i];
      for (const d of dayKeys) c += dayCost(i, d);
    }
    return c;
  }

  function construct() {
    for (const i of P) W[i].set(pinnedBase[i]);
    const cnt = new Array(problem.staff.length).fill(0);
    for (const i of P) cnt[i] = W[i].reduce((a, b) => a + b, 0);
    const cur = Array.from({ length: S }, () => []);
    for (let si = 0; si < S; si++) {
      if (nAt[si] === 0) continue;
      const pa = prevAdj[si];
      const keyed = elig[si].map((i) => ({ i, k1: cnt[i] + (pa !== null && W[i][pa] ? 0.9 : 0), k2: rand() }));
      keyed.sort((x, y) => x.k1 - y.k1 || x.k2 - y.k2);
      const { match } = perfectMatch(seatPos[si], keyed.map((x) => x.i), qual);
      if (match === null) throw new Error('初始排班失敗');
      for (const i of match) { W[i][si] = 1; cnt[i] += 1; }
      cur[si] = [...match];
    }
    return { cur, cnt };
  }

  function anneal(cur, cnt, iters, t0, t1, stopAt) {
    let cost = totalCost(cnt);
    if (!movable.length || iters <= 0) return cost;
    for (let it = 0; it < iters; it++) {
      if ((it & 255) === 0 && now() > stopAt) break;
      const T = t0 * (t1 / t0) ** (it / iters);
      if (movable.length >= 2 && rand() < 0.5) {
        // 對調：a 把 s 班讓給 b，b 把 t 班讓給 a（總班次數不變）
        const s = movable[Math.floor(rand() * movable.length)];
        const t = movable[Math.floor(rand() * movable.length)];
        if (s === t) continue;
        const cs = cur[s]; const ct = cur[t];
        const ia = Math.floor(rand() * cs.length);
        const ib = Math.floor(rand() * ct.length);
        const a = cs[ia]; const b = ct[ib];
        if (a === b || W[a][t] || W[b][s]) continue;
        if (!eligSet[t].has(a) || !eligSet[s].has(b)) continue;
        const ds = slotDay[s]; const dt = slotDay[t];
        const days = ds === dt ? [ds] : [ds, dt];
        let old = 0;
        for (const x of [a, b]) for (const d of days) old += dayCost(x, d);
        W[a][s] = 0; W[b][s] = 1; W[b][t] = 0; W[a][t] = 1;
        let nw = 0;
        for (const x of [a, b]) for (const d of days) nw += dayCost(x, d);
        const delta = nw - old;
        if (delta <= 0 || rand() < Math.exp(-delta / T)) {
          const ns = cs.slice(); ns[ia] = b;
          const nt = ct.slice(); nt[ib] = a;
          if (feasible(s, ns) && feasible(t, nt)) { cur[s] = ns; cur[t] = nt; cost += delta; continue; }
        }
        W[a][s] = 1; W[b][s] = 0; W[b][t] = 1; W[a][t] = 0;
      } else {
        // 換人：a 在 s 班下班，由閒置的 b 接手
        const s = movable[Math.floor(rand() * movable.length)];
        const cs = cur[s];
        const cand = elig[s];
        if (!cand.length) continue;
        const ia = Math.floor(rand() * cs.length);
        const a = cs[ia];
        const b = cand[Math.floor(rand() * cand.length)];
        if (W[b][s]) continue;
        const d = slotDay[s];
        const old = dayCost(a, d) + dayCost(b, d) + W_COUNT * (cnt[a] * cnt[a] + cnt[b] * cnt[b]);
        W[a][s] = 0; W[b][s] = 1; cnt[a] -= 1; cnt[b] += 1;
        const nw = dayCost(a, d) + dayCost(b, d) + W_COUNT * (cnt[a] * cnt[a] + cnt[b] * cnt[b]);
        const delta = nw - old;
        if (delta <= 0 || rand() < Math.exp(-delta / T)) {
          const ns = cs.slice(); ns[ia] = b;
          if (feasible(s, ns)) { cur[s] = ns; cost += delta; continue; }
        }
        W[a][s] = 1; W[b][s] = 0; cnt[a] += 1; cnt[b] -= 1;
      }
    }
    return cost;
  }

  const seatsTotal = nAt.reduce((a, b) => a + b, 0);
  const iters = Math.min(options.maxIters, Math.max(40000, 150 * Math.max(1, seatsTotal)));
  const restarts = Math.max(1, options.restarts);
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const remaining = deadline - now();
    if (r > 0 && remaining <= 0) break;
    const stopAt = now() + (remaining > 0 ? remaining / (restarts - r) : 50);
    const { cur, cnt } = construct();
    anneal(cur, cnt, Math.floor(iters * 0.9), 120, 3, stopAt);
    anneal(cur, cnt, Math.floor(iters * 0.1), 1, 0.01, stopAt + 200);
    const c = totalCost(cnt);
    if (best === null || c < best.cost) {
      const snap = new Map();
      for (const i of P) snap.set(i, Uint8Array.from(W[i]));
      best = { cost: c, cur: cur.map((x) => [...x]), W: snap };
    }
  }
  for (const i of P) W[i].set(best.W.get(i));
  return best.cur;
}
