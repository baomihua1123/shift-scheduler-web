// 資料模型與自動存檔。不依賴瀏覽器 API（儲存層以參數注入），所以可以在 Node 中測試。
import {
  validateEvent, layoutSignature, sortedDays, addDays, daysBetween, newEventDraft, eventLayout, assignmentKey,
  analyzeEvent, buildView, buildMeta,
} from './event-model.js';

export const SCHEMA_VERSION = 1;
export const APP_TAG = 'shift-scheduler';

export class TooNewError extends Error {}
export class CorruptError extends Error {}
export class ConflictError extends Error {
  constructor(remote) { super('資料夾內的資料已被其他視窗或電腦更改'); this.remote = remote; }
}

export function emptyData() {
  return {
    app: APP_TAG,
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    savedAt: null,
    seq: { position: 0, staff: 0, event: 0 },
    positions: [],   // { id, name, note, active, order }
    staff: [],       // { id, name, note, active, positionIds }
    events: [],      // 活動（之後階段加入）
  };
}

// 驗證並補齊欄位；資料來自更新版本時拒絕開啟，避免損壞
export function normalize(raw) {
  if (!raw || typeof raw !== 'object' || raw.app !== APP_TAG) {
    throw new Error('這不是本程式的資料檔');
  }
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > SCHEMA_VERSION) {
    throw new TooNewError('這份資料是由較新版本的程式建立的，請先更新程式（重新整理網頁）再開啟，以免資料損壞。');
  }
  const d = { ...emptyData(), ...raw };
  d.positions = Array.isArray(raw.positions) ? raw.positions : [];
  d.staff = Array.isArray(raw.staff) ? raw.staff : [];
  d.events = Array.isArray(raw.events) ? raw.events : [];
  d.seq = { position: 0, staff: 0, event: 0, ...(raw.seq || {}) };
  d.seq.position = Math.max(d.seq.position, ...d.positions.map((p) => p.id), 0);
  d.seq.staff = Math.max(d.seq.staff, ...d.staff.map((s) => s.id), 0);
  d.seq.event = Math.max(d.seq.event, ...d.events.map((e) => e.id), 0);
  d.revision = Number.isFinite(raw.revision) ? raw.revision : 0;
  // 未來的資料版本升級寫在這裡
  d.schemaVersion = SCHEMA_VERSION;
  return d;
}

export class Store {
  /**
   * @param storage 需提供 load() / save(data)；save 在資料被外部更改時要丟出 ConflictError
   * @param opts.shadow 選用：{ write(data, dirty) }，保存尚未存入資料夾的暫存
   */
  constructor(storage, opts = {}) {
    this.storage = storage;
    this.debounceMs = opts.debounceMs ?? 150;
    this.retryMs = opts.retryMs ?? 1500;
    this._retries = 0;
    this._retryTimer = null;
    this.now = opts.now || (() => new Date());
    this.shadow = opts.shadow || null;
    this.data = emptyData();
    this.status = { state: 'idle', savedAt: null, message: '' };
    this._changeListeners = new Set();
    this._statusListeners = new Set();
    this._timer = null;
    this._saving = null;
    this._pending = false;
    this._conflict = null;
  }

  // ---------- 載入與事件 ----------
  async open() {
    const raw = await this.storage.load();
    this.data = raw ? normalize(raw) : emptyData();
    this._conflict = null;
    this._setStatus('saved', raw ? raw.savedAt : null);
    this._emitChange();
    return Boolean(raw);
  }

  subscribe(fn) { this._changeListeners.add(fn); return () => this._changeListeners.delete(fn); }
  onStatus(fn) { this._statusListeners.add(fn); return () => this._statusListeners.delete(fn); }
  _emitChange() { for (const fn of this._changeListeners) fn(this); }
  _setStatus(state, savedAt = null, message = '') {
    this.status = { state, savedAt: savedAt ?? this.status.savedAt, message };
    for (const fn of this._statusListeners) fn(this.status);
  }
  get conflict() { return this._conflict; }

  // ---------- 自動存檔 ----------
  commit() {
    this.data.revision += 1;
    this.data.savedAt = this.now().toISOString();
    this._emitChange();
    this._shadowWrite(true);
    this._setStatus('saving');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this.flush().catch(() => {}); }, this.debounceMs);
  }

  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._saving) { this._pending = true; await this._saving; return; }
    this._saving = this._runSave();
    try { await this._saving; } finally { this._saving = null; }
  }

  async _runSave() {
    for (;;) {
      this._pending = false;
      const rev = this.data.revision;
      try {
        await this.storage.save(this.data);
        this._retries = 0;
        this._setStatus('saved', this.data.savedAt);
        this._shadowWrite(this.data.revision !== rev);
      } catch (e) {
        if (e instanceof ConflictError) {
          this._conflict = e;
          this._setStatus('conflict', null, e.message);
        } else {
          this._setStatus('error', null, (e && e.message) || String(e));
          // 檔案暫時被占用（例如雲端同步正在讀取）時，自動再試幾次
          if (this._retries < 3) {
            this._retries += 1;
            clearTimeout(this._retryTimer);
            this._retryTimer = setTimeout(() => { this.flush().catch(() => {}); }, this.retryMs);
          }
        }
        return;
      }
      if (!this._pending && this.data.revision === rev) return;
    }
  }

  retry() { this._retries = 0; return this.flush(); }

  _shadowWrite(dirty) {
    if (!this.shadow) return;
    Promise.resolve(this.shadow.write(this.data, dirty)).catch(() => {});
  }

  // 資料夾內的資料被外部更改時的處理：'reload' 放棄本機修改改用資料夾內容；'overwrite' 以目前畫面資料覆蓋
  async resolveConflict(choice) {
    if (!this._conflict) return;
    const remote = this._conflict.remote;
    this._conflict = null;
    if (choice === 'reload') {
      const raw = await this.storage.load();
      this.data = raw ? normalize(raw) : emptyData();
      this._setStatus('saved', this.data.savedAt);
      this._shadowWrite(false);
      this._emitChange();
    } else {
      if (this.storage.acceptRemoteRevision) this.storage.acceptRemoteRevision(remote ? remote.revision : null);
      this.data.revision = Math.max(this.data.revision, remote && Number.isFinite(remote.revision) ? remote.revision : 0);
      this.commit();
      await this.flush();
    }
  }

  // 整份資料取代（還原備份、匯入完整資料）
  replaceAll(raw) {
    const next = normalize(raw);
    next.revision = Math.max(this.data.revision, next.revision);
    this.data = next;
    this.commit();
  }

  exportJSON() { return JSON.stringify(this.data, null, 1); }

  // ---------- 查詢 ----------
  positions({ includeInactive = false } = {}) {
    return this.data.positions
      .filter((p) => includeInactive || p.active)
      .slice()
      .sort((a, b) => a.order - b.order || a.id - b.id);
  }
  getPosition(id) { return this.data.positions.find((p) => p.id === id) || null; }
  positionName(id) { const p = this.getPosition(id); return p ? p.name : '（已刪除）'; }

  staffList({ includeInactive = false } = {}) {
    return this.data.staff.filter((s) => includeInactive || s.active).slice().sort((a, b) => a.id - b.id);
  }
  getStaff(id) { return this.data.staff.find((s) => s.id === id) || null; }

  isPositionUsed(id) {
    return this.data.events.some((ev) => (ev.positions || []).some((p) => p.positionId === id));
  }
  isStaffUsed(id) {
    return this.data.events.some((ev) =>
      (ev.staffIds || []).includes(id) ||
      Object.values(ev.assignments || {}).some((a) => a && a.staffId === id));
  }

  // ---------- 崗位 ----------
  _cleanName(name, label) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error(`${label}不可空白`);
    return n;
  }

  addPosition(name, note = '') {
    const n = this._cleanName(name, '崗位名稱');
    if (this.data.positions.some((p) => p.name === n)) throw new Error(`已有同名的崗位：${n}`);
    const id = ++this.data.seq.position;
    const order = Math.max(0, ...this.data.positions.map((p) => p.order)) + 1;
    this.data.positions.push({ id, name: n, note: String(note).trim(), active: true, order });
    this.commit();
    return id;
  }

  updatePosition(id, { name, note }) {
    const p = this.getPosition(id);
    if (!p) throw new Error('找不到這個崗位');
    const n = this._cleanName(name, '崗位名稱');
    if (this.data.positions.some((x) => x.id !== id && x.name === n)) throw new Error(`已有同名的崗位：${n}`);
    p.name = n;
    p.note = String(note ?? '').trim();
    this.commit();
  }

  setPositionActive(id, active) {
    const p = this.getPosition(id);
    if (!p) return;
    p.active = Boolean(active);
    this.commit();
  }

  // 曾被活動使用就改為停用（保留歷史），否則直接刪除
  deletePosition(id) {
    const p = this.getPosition(id);
    if (!p) return 'deleted';
    if (this.isPositionUsed(id)) { p.active = false; this.commit(); return 'deactivated'; }
    this.data.positions = this.data.positions.filter((x) => x.id !== id);
    for (const s of this.data.staff) s.positionIds = s.positionIds.filter((pid) => pid !== id);
    this.commit();
    return 'deleted';
  }

  movePosition(id, delta) {
    const list = this.positions({ includeInactive: true });
    const i = list.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((p, idx) => { p.order = idx + 1; });
    this.commit();
  }

  // ---------- 人員 ----------
  addStaff({ name, positionIds = [], note = '' }) {
    const n = this._cleanName(name, '姓名');
    if (this.data.staff.some((s) => s.name === n)) throw new Error(`已有同名的人員：${n}`);
    const id = ++this.data.seq.staff;
    this.data.staff.push({ id, name: n, note: String(note).trim(), active: true, positionIds: [...new Set(positionIds)] });
    this.commit();
    return id;
  }

  updateStaff(id, { name, positionIds, note }) {
    const s = this.getStaff(id);
    if (!s) throw new Error('找不到這位人員');
    const n = this._cleanName(name, '姓名');
    if (this.data.staff.some((x) => x.id !== id && x.name === n)) throw new Error(`已有同名的人員：${n}`);
    s.name = n;
    s.note = String(note ?? '').trim();
    s.positionIds = [...new Set(positionIds || [])];
    this.commit();
  }

  setStaffActive(id, active) {
    const s = this.getStaff(id);
    if (!s) return;
    s.active = Boolean(active);
    this.commit();
  }

  deleteStaff(id) {
    const s = this.getStaff(id);
    if (!s) return 'deleted';
    if (this.isStaffUsed(id)) { s.active = false; this.commit(); return 'deactivated'; }
    this.data.staff = this.data.staff.filter((x) => x.id !== id);
    this.commit();
    return 'deleted';
  }

  // ---------- 活動 ----------
  events() {
    const first = (ev) => (ev.days.length ? sortedDays(ev)[0].date : '9999-99-99');
    return this.data.events.slice().sort((a, b) => (first(a) < first(b) ? 1 : first(a) > first(b) ? -1 : b.id - a.id));
  }
  getEvent(id) { return this.data.events.find((e) => e.id === id) || null; }

  // 儲存前預覽：回傳 { layoutChanged, hasAssignments }，供畫面在會清除班表時先提醒
  previewSaveEvent(draft) {
    if (draft.id === null || draft.id === undefined) return { layoutChanged: false, hasAssignments: false };
    const old = this.getEvent(draft.id);
    if (!old) return { layoutChanged: false, hasAssignments: false };
    return {
      layoutChanged: layoutSignature(old) !== layoutSignature(draft),
      hasAssignments: Object.keys(old.assignments || {}).length > 0,
    };
  }

  saveEvent(draft) {
    validateEvent(draft);
    const nowIso = this.now().toISOString();
    const days = sortedDays(draft).map((d) => ({
      date: d.date, start: d.start, end: d.end,
      breaks: (d.breaks || []).map((b) => ({ label: (b.label || '').trim() || '休息', start: b.start, end: b.end })),
    }));
    const order = new Map(this.positions({ includeInactive: true }).map((p, i) => [p.id, i]));
    const positions = draft.positions
      .map((p) => ({ positionId: p.positionId, headcount: Number(p.headcount), dedicated: p.dedicated === true ? true : p.dedicated === false ? false : null }))
      .sort((a, b) => (order.get(a.positionId) ?? 0) - (order.get(b.positionId) ?? 0));
    const staffIds = [...new Set(draft.staffIds)].sort((a, b) => a - b);
    const base = {
      name: String(draft.name).trim(), note: String(draft.note || '').trim(),
      shiftMinutes: Number(draft.shiftMinutes), mergeThreshold: draft.mergeThreshold ?? 0.5,
      days, positions, staffIds,
    };

    if (draft.id === null || draft.id === undefined) {
      const id = ++this.data.seq.event;
      this.data.events.push({
        id, ...base, status: 'draft', assignments: {}, lastGeneration: null,
        copiedFrom: draft.copiedFrom ?? null, createdAt: nowIso, updatedAt: nowIso,
      });
      this.commit();
      return { id, layoutChanged: false, pruned: 0 };
    }

    const ev = this.getEvent(draft.id);
    if (!ev) throw new Error('找不到這個活動');
    if (ev.status === 'final') throw new Error('此活動已定稿，請先「解除定稿」才能修改設定');
    const layoutChanged = layoutSignature(ev) !== layoutSignature({ ...base });
    Object.assign(ev, base, { updatedAt: nowIso });
    let pruned = 0;
    if (layoutChanged) {
      pruned = Object.keys(ev.assignments || {}).length;
      ev.assignments = {};
      ev.lastGeneration = null;
    } else {
      const posHead = new Map(positions.map((p) => [p.positionId, p.headcount]));
      const staffSet = new Set(staffIds);
      for (const [key, a] of Object.entries(ev.assignments || {})) {
        const [, , pid, k] = key.split('|');
        if (!posHead.has(Number(pid)) || Number(k) >= posHead.get(Number(pid)) || !staffSet.has(a.staffId)) {
          delete ev.assignments[key];
          pruned += 1;
        }
      }
    }
    this._refreshStatus(ev);
    this.commit();
    return { id: ev.id, layoutChanged, pruned };
  }

  _refreshStatus(ev) {
    if (ev.status === 'final') return;
    ev.status = Object.keys(ev.assignments || {}).length ? 'scheduled' : 'draft';
  }

  deleteEvent(id) {
    this.data.events = this.data.events.filter((e) => e.id !== id);
    this.commit();
  }

  // 複製過往活動的設定（不含班表）；startDate 有給時整體平移日期
  duplicateEvent(id, newName, startDate = null) {
    const src = this.getEvent(id);
    if (!src) throw new Error('找不到要複製的活動');
    const days = sortedDays(src);
    const offset = startDate && days.length ? daysBetween(days[0].date, startDate) : 0;
    return this.saveEvent({
      id: null, name: newName, note: src.note, shiftMinutes: src.shiftMinutes, mergeThreshold: src.mergeThreshold,
      copiedFrom: src.id,
      days: days.map((d) => ({ date: addDays(d.date, offset), start: d.start, end: d.end, breaks: d.breaks.map((b) => ({ ...b })) })),
      positions: src.positions.map((p) => ({ ...p })),
      staffIds: [...src.staffIds],
    }).id;
  }

  // 套用排班結果：assignments 為 { 'YYYY-MM-DD|HH:MM|崗位id|第幾位': 人員id }；已鎖定的格子保留
  applyGeneration(id, assignments, info = null) {
    const ev = this.getEvent(id);
    if (!ev) throw new Error('找不到這個活動');
    if (ev.status === 'final') throw new Error('此活動已定稿，請先「解除定稿」才能重新排班');
    const next = {};
    for (const [key, a] of Object.entries(ev.assignments || {})) if (a && a.locked) next[key] = a;
    for (const [key, staffId] of Object.entries(assignments)) if (!next[key]) next[key] = { staffId, locked: false };
    ev.assignments = next;
    ev.lastGeneration = info ? { at: this.now().toISOString(), warnings: info.warnings || [], notes: info.notes || [] } : null;
    ev.updatedAt = this.now().toISOString();
    this._refreshStatus(ev);
    this.commit();
  }

  clearAssignments(id, keepLocked = false) {
    const ev = this.getEvent(id);
    if (!ev) return;
    if (ev.status === 'final') throw new Error('此活動已定稿，請先「解除定稿」才能清除班表');
    ev.assignments = keepLocked
      ? Object.fromEntries(Object.entries(ev.assignments || {}).filter(([, a]) => a && a.locked))
      : {};
    ev.lastGeneration = null;
    ev.updatedAt = this.now().toISOString();
    this._refreshStatus(ev);
    this.commit();
  }

  // ---------- 班表手動調整、鎖定、定稿 ----------
  _editableEvent(id) {
    const ev = this.getEvent(id);
    if (!ev) throw new Error('找不到這個活動');
    if (ev.status === 'final') throw new Error('此活動已定稿，請先「解除定稿」才能修改班表');
    return ev;
  }

  // key 為 'YYYY-MM-DD|HH:MM|崗位id|第幾位'；staffId 為 null 代表清空
  setAssignment(id, key, staffId) {
    const ev = this._editableEvent(id);
    if (staffId === null || staffId === undefined || staffId === '') delete ev.assignments[key];
    else {
      const old = ev.assignments[key];
      ev.assignments[key] = { staffId: Number(staffId), locked: old ? Boolean(old.locked) : false };
    }
    ev.updatedAt = this.now().toISOString();
    this._refreshStatus(ev);
    this.commit();
  }

  toggleLock(id, key) {
    const ev = this._editableEvent(id);
    const a = ev.assignments[key];
    if (!a) throw new Error('這個格子還沒有安排人員，無法鎖定');
    a.locked = !a.locked;
    ev.updatedAt = this.now().toISOString();
    this.commit();
    return a.locked;
  }

  finalizeEvent(id) {
    const ev = this.getEvent(id);
    if (!ev) throw new Error('找不到這個活動');
    if (ev.status === 'final') return;
    if (!Object.keys(ev.assignments || {}).length) throw new Error('還沒有排班，無法定稿');
    const { an } = analyzeEvent(this, ev);
    if (an.errors.length) throw new Error(`班表仍有 ${an.errors.length} 個問題，無法定稿：\n${an.errors.slice(0, 8).join('\n')}`);
    ev.snapshot = { at: this.now().toISOString(), view: JSON.parse(JSON.stringify(buildView(this, ev))), meta: buildMeta(this, ev) };
    ev.status = 'final';
    ev.updatedAt = this.now().toISOString();
    this.commit();
  }

  unfinalizeEvent(id) {
    const ev = this.getEvent(id);
    if (!ev) return;
    delete ev.snapshot;
    ev.status = 'scheduled';
    this._refreshStatus(ev);
    ev.updatedAt = this.now().toISOString();
    this.commit();
  }

  // ---------- 匯入 ----------
  _findPositionByName(name) { return this.data.positions.find((p) => p.name === name) || null; }
  _findStaffByName(name) { return this.data.staff.find((p) => p.name === name) || null; }

  _ensurePosition(name, warnings) {
    let p = this._findPositionByName(name);
    if (!p) { const id = this.addPosition(name); p = this.getPosition(id); warnings.push(`已自動新增崗位「${name}」`); }
    else if (!p.active) this.setPositionActive(p.id, true);
    return p.id;
  }

  /** rows：[{ name, positions:[崗位名稱], note }]。同名者更新適用崗位；沒有的崗位會自動新增。 */
  importStaffRows(rows) {
    const rep = { added: 0, updated: 0, warnings: [] };
    for (const row of rows) {
      const name = String(row.name || '').trim();
      if (!name) continue;
      const pids = [...new Set(row.positions.map((n) => this._ensurePosition(n.trim(), rep.warnings)))];
      const ex = this._findStaffByName(name);
      if (ex) {
        this.updateStaff(ex.id, { name, positionIds: pids, note: row.note || ex.note });
        if (!ex.active) this.setStaffActive(ex.id, true);
        rep.updated += 1;
      } else { this.addStaff({ name, positionIds: pids, note: row.note || '' }); rep.added += 1; }
    }
    return rep;
  }

  /** imp：excel-io 的 readEventWorkbook 結果。回傳 { id, warnings }。 */
  importEvent(imp) {
    const warnings = [...(imp.warnings || [])];
    const meta = imp.meta;
    const posIds = new Map();
    for (const pm of meta.positions || []) posIds.set(pm.name, this._ensurePosition(pm.name, warnings));

    const staffIds = new Map();
    for (const am of meta.attendees || []) {
      let st = this._findStaffByName(am.name);
      if (!st) {
        if (imp.source !== 'package') { warnings.push(`人員「${am.name}」不在人員名單中，已略過（請先到「人員管理」新增）`); continue; }
        const qual = (am.positions || []).map((n) => this._ensurePosition(n, warnings));
        st = this.getStaff(this.addStaff({ name: am.name, positionIds: qual }));
        warnings.push(`已自動新增人員「${am.name}」`);
      } else if (!st.active) this.setStaffActive(st.id, true);
      staffIds.set(am.name, st.id);
    }

    let name = meta.name || '匯入的活動';
    const names = new Set(this.data.events.map((e) => e.name));
    if (names.has(name)) { let n = 2; while (names.has(`${name} (${n})`)) n += 1; name = `${name} (${n})`; }

    const draft = newEventDraft(meta.days && meta.days[0] ? meta.days[0].date : '2000-01-01');
    Object.assign(draft, {
      name, note: meta.note || '', shiftMinutes: Number(meta.shiftMinutes || 90), mergeThreshold: meta.mergeThreshold ?? 0.5,
      days: (meta.days || []).map((d) => ({ date: d.date, start: d.start, end: d.end, breaks: (d.breaks || []).map((b) => ({ label: b.label || '休息', start: b.start, end: b.end })) })),
      positions: (meta.positions || []).map((pm) => ({ positionId: posIds.get(pm.name), headcount: Number(pm.headcount || 1), dedicated: pm.dedicated ?? null })),
      staffIds: [...new Set(staffIds.values())],
    });
    const id = this.saveEvent(draft).id;
    const ev = this.getEvent(id);

    const ends = new Map(eventLayout(ev).slots.map((s) => [`${s.date}|${s.start}`, s.end]));
    const head = new Map(ev.positions.map((p) => [p.positionId, p.headcount]));
    for (const a of imp.assignments || []) {
      const end = ends.get(`${a.date}|${a.start}`);
      if (end === undefined || end !== a.end) { warnings.push(`找不到對應的班次：${a.date} ${a.start}~${a.end}，已略過`); continue; }
      const pid = posIds.get(a.position);
      if (pid === undefined || !(Number(a.k) < head.get(pid))) continue;
      const sid = staffIds.get(a.staff);
      if (sid === undefined) { warnings.push(`${a.date} ${a.start} 「${a.position}」的人員「${a.staff}」無法對應，已留空`); continue; }
      ev.assignments[assignmentKey(a.date, a.start, pid, Number(a.k))] = { staffId: sid, locked: false };
    }
    this._refreshStatus(ev);
    this.commit();
    return { id, warnings };
  }
}
