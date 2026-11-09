// 資料模型與自動存檔。不依賴瀏覽器 API（儲存層以參數注入），所以可以在 Node 中測試。
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
        this._setStatus('saved', this.data.savedAt);
        this._shadowWrite(this.data.revision !== rev);
      } catch (e) {
        if (e instanceof ConflictError) {
          this._conflict = e;
          this._setStatus('conflict', null, e.message);
        } else {
          this._setStatus('error', null, (e && e.message) || String(e));
        }
        return;
      }
      if (!this._pending && this.data.revision === rev) return;
    }
  }

  retry() { return this.flush(); }

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
}
