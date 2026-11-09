// 把資料存成使用者所選資料夾裡的真實檔案（File System Access API，Chrome / Edge）。
// 資料檔：排班資料.json；備份放在「備份」子資料夾。
import { ConflictError, CorruptError } from './store.js';
import { kvGet, kvSet, kvDel } from './idb.js';
import { stamp } from './util.js';

export const DATA_FILE = '排班資料.json';
export const BACKUP_DIR = '備份';
export const BACKUP_PREFIX = '排班資料_';
export const KEEP_BACKUPS = 10;
const HANDLE_KEY = 'dirHandle';
const SHADOW_KEY = 'shadow';

export function folderApiSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// ---------- 已選資料夾的記憶 ----------
// 測試用的掛鉤：自動化測試環境無法把資料夾代碼存進 IndexedDB，測試時可改用自訂的記憶方式
const testHandleStore = () =>
  (typeof window !== 'undefined' && window.__shiftSchedulerTest && window.__shiftSchedulerTest.handleStore) || null;

export const rememberedHandle = () => (testHandleStore() ? testHandleStore().get() : kvGet(HANDLE_KEY));
export const rememberHandle = (handle) => (testHandleStore() ? testHandleStore().set(handle) : kvSet(HANDLE_KEY, handle));
export const forgetHandle = () => (testHandleStore() ? testHandleStore().del() : kvDel(HANDLE_KEY));

export async function permissionState(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'granted';
  return handle.queryPermission({ mode: 'readwrite' });
}

export async function requestPermission(handle) {
  if (!handle || typeof handle.requestPermission !== 'function') return 'granted';
  return handle.requestPermission({ mode: 'readwrite' });
}

// ---------- 尚未存入資料夾的暫存（瀏覽器內，當資料夾暫時無法寫入時的保險） ----------
export const shadow = {
  write: (data, dirty) => kvSet(SHADOW_KEY, { data: JSON.parse(JSON.stringify(data)), dirty: Boolean(dirty), at: Date.now() }),
  read: () => kvGet(SHADOW_KEY),
  clear: () => kvDel(SHADOW_KEY),
};

export class FolderStorage {
  constructor(dirHandle) {
    this.dir = dirHandle;
    this.knownRevision = null; // 我們最後一次讀到或寫入的版本；用來偵測資料夾內容被其他人更改
  }

  get name() { return this.dir.name; }

  async _readFile() {
    let fh;
    try {
      fh = await this.dir.getFileHandle(DATA_FILE);
    } catch (e) {
      if (e && e.name === 'NotFoundError') return null;
      throw e;
    }
    const text = await (await fh.getFile()).text();
    return text;
  }

  async load() {
    const text = await this._readFile();
    if (text === null) { this.knownRevision = null; return null; }
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new CorruptError('資料檔內容損毀，無法讀取'); }
    this.knownRevision = Number.isFinite(json.revision) ? json.revision : 0;
    return json;
  }

  acceptRemoteRevision(rev) { this.knownRevision = rev; }

  async save(data) {
    const currentText = await this._readFile();
    if (currentText !== null && this.knownRevision !== null) {
      let cur = null;
      try { cur = JSON.parse(currentText); } catch (e) { cur = null; }
      if (cur && (cur.revision ?? 0) !== this.knownRevision) throw new ConflictError(cur);
    }
    const text = JSON.stringify(data, null, 1);
    const rev = data.revision;
    const fh = await this.dir.getFileHandle(DATA_FILE, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(text);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (_) { /* ignore */ }
      throw e;
    }
    this.knownRevision = rev;
  }

  // ---------- 備份 ----------
  async _backupDir(create = false) {
    try {
      return await this.dir.getDirectoryHandle(BACKUP_DIR, { create });
    } catch (e) {
      if (e && e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async listBackups() {
    const dir = await this._backupDir(false);
    if (!dir) return [];
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !name.startsWith(BACKUP_PREFIX) || !name.endsWith('.json')) continue;
      const file = await handle.getFile();
      out.push({ name, size: file.size, lastModified: file.lastModified });
    }
    out.sort((a, b) => (a.name < b.name ? 1 : -1)); // 新的在前
    return out;
  }

  async readBackup(name) {
    const dir = await this._backupDir(false);
    if (!dir) throw new Error('找不到備份資料夾');
    const fh = await dir.getFileHandle(name);
    const text = await (await fh.getFile()).text();
    return { text, json: JSON.parse(text) };
  }

  async _writeBackupFile(text, label = '') {
    const dir = await this._backupDir(true);
    const name = `${BACKUP_PREFIX}${stamp()}${label ? `_${label}` : ''}.json`;
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return name;
  }

  async pruneBackups(keep = KEEP_BACKUPS) {
    const list = await this.listBackups();
    const dir = await this._backupDir(false);
    for (const b of list.slice(keep)) {
      try { await dir.removeEntry(b.name); } catch (_) { /* ignore */ }
    }
  }

  // 每次開啟程式時，先把上一次使用結束時的資料備份起來（內容和最新備份相同就略過）
  async backupOnOpen() {
    const text = await this._readFile();
    if (text === null) return null;
    const list = await this.listBackups();
    if (list.length) {
      try {
        const latest = await this.readBackup(list[0].name);
        if (latest.text === text) return null;
      } catch (_) { /* 最新備份讀不到就照常再備份 */ }
    }
    const name = await this._writeBackupFile(text);
    await this.pruneBackups();
    return name;
  }

  // 手動備份或還原前的保險備份
  async backupNow(label = '') {
    const text = await this._readFile();
    if (text === null) return null;
    const name = await this._writeBackupFile(text, label);
    await this.pruneBackups();
    return name;
  }

  // 資料檔損毀時，把壞檔另存起來再讓使用者還原
  async quarantineCorrupt() {
    const text = await this._readFile();
    if (text === null) return null;
    const dir = await this._backupDir(true);
    const name = `損毀的資料檔_${stamp()}.json`;
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return name;
  }
}
