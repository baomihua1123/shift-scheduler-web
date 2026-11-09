import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Store, ConflictError, TooNewError, normalize, emptyData } from '../js/store.js';

class MemoryStorage {
  constructor(initial = null) { this.file = initial ? JSON.parse(JSON.stringify(initial)) : null; this.known = null; this.saves = 0; }
  async load() { if (!this.file) { this.known = null; return null; } this.known = this.file.revision; return JSON.parse(JSON.stringify(this.file)); }
  async save(data) {
    if (this.file && this.known !== null && this.file.revision !== this.known) throw new ConflictError(this.file);
    this.file = JSON.parse(JSON.stringify(data)); this.known = data.revision; this.saves += 1;
  }
  acceptRemoteRevision(r) { this.known = r; }
}
const mk = async (initial) => { const st = new MemoryStorage(initial); const s = new Store(st, { debounceMs: 5 }); await s.open(); return { st, s }; };

test('新增崗位與人員，並自動存檔', async () => {
  const { st, s } = await mk();
  const p1 = s.addPosition('導播', '主控');
  const p2 = s.addPosition('攝影');
  s.addStaff({ name: ' 王小明 ', positionIds: [p1, p2, p1] });
  await s.flush();
  assert.equal(st.file.positions.length, 2);
  assert.equal(st.file.staff[0].name, '王小明');
  assert.deepEqual(st.file.staff[0].positionIds, [p1, p2]);
  assert.equal(s.status.state, 'saved');
  assert.ok(st.file.revision >= 3);
});

test('防抖：連續修改只寫入少數幾次，且最後一次內容完整', async () => {
  const { st, s } = await mk();
  for (let i = 0; i < 20; i++) s.addPosition(`崗位${i}`);
  await s.flush();
  assert.equal(st.file.positions.length, 20);
  assert.ok(st.saves <= 3, `寫入次數 ${st.saves}`);
});

test('同名檢查與空白檢查', async () => {
  const { s } = await mk();
  s.addPosition('導播');
  assert.throws(() => s.addPosition('導播'), /已有同名的崗位/);
  assert.throws(() => s.addPosition('   '), /不可空白/);
  s.addStaff({ name: '甲' });
  assert.throws(() => s.addStaff({ name: '甲' }), /已有同名的人員/);
  const id = s.addStaff({ name: '乙' });
  assert.throws(() => s.updateStaff(id, { name: '甲', positionIds: [], note: '' }), /已有同名/);
});

test('刪除：未被使用就直接刪除並清掉人員的崗位；被活動使用就停用', async () => {
  const { s } = await mk();
  const p = s.addPosition('導播');
  const q = s.addPosition('攝影');
  const a = s.addStaff({ name: '甲', positionIds: [p, q] });
  assert.equal(s.deletePosition(p), 'deleted');
  assert.deepEqual(s.getStaff(a).positionIds, [q]);
  s.data.events.push({ id: 1, name: '活動', positions: [{ positionId: q, headcount: 1 }], staffIds: [a] });
  assert.equal(s.deletePosition(q), 'deactivated');
  assert.equal(s.getPosition(q).active, false);
  assert.equal(s.deleteStaff(a), 'deactivated');
  assert.equal(s.getStaff(a).active, false);
  assert.equal(s.positionName(q), '攝影'); // 停用後歷史仍看得到名稱
  const b = s.addStaff({ name: '乙' });
  assert.equal(s.deleteStaff(b), 'deleted');
});

test('崗位排序：上移、下移', async () => {
  const { s } = await mk();
  const a = s.addPosition('A'); const b = s.addPosition('B'); const c = s.addPosition('C');
  s.movePosition(c, -1);
  assert.deepEqual(s.positions().map((p) => p.name), ['A', 'C', 'B']);
  s.movePosition(a, -1); // 已在最前，不動
  s.movePosition(a, 1);
  assert.deepEqual(s.positions().map((p) => p.name), ['C', 'A', 'B']);
  assert.ok(b);
});

test('重新開啟可讀回資料，編號不會重複使用', async () => {
  const { st, s } = await mk();
  const p = s.addPosition('導播');
  s.deletePosition(p);
  await s.flush();
  const s2 = new Store(st, { debounceMs: 5 });
  await s2.open();
  const p2 = s2.addPosition('攝影');
  assert.notEqual(p2, p);
});

test('偵測資料夾內容被其他人更改（衝突），可選擇重新載入或覆蓋', async () => {
  const { st, s } = await mk();
  s.addPosition('A');
  await s.flush();
  st.file = { ...st.file, revision: st.file.revision + 5, positions: [{ id: 99, name: '外來', note: '', active: true, order: 1 }] }; // 其他電腦改的
  s.addPosition('B');
  await s.flush();
  assert.equal(s.status.state, 'conflict');
  assert.ok(s.conflict);
  await s.resolveConflict('reload');
  assert.deepEqual(s.positions().map((p) => p.name), ['外來']);
  assert.equal(s.status.state, 'saved');

  s.addPosition('C');
  await s.flush();
  st.file = { ...st.file, revision: st.file.revision + 3 };
  s.addPosition('D');
  await s.flush();
  assert.equal(s.status.state, 'conflict');
  await s.resolveConflict('overwrite');
  assert.equal(s.status.state, 'saved');
  assert.deepEqual(st.file.positions.map((p) => p.name).sort(), ['C', 'D', '外來'].sort());
});

test('存檔失敗會顯示錯誤，之後可重試成功', async () => {
  const { st, s } = await mk();
  let fail = true;
  const orig = st.save.bind(st);
  st.save = async (d) => { if (fail) throw new Error('磁碟忙碌'); return orig(d); };
  s.addPosition('A');
  await s.flush();
  assert.equal(s.status.state, 'error');
  assert.match(s.status.message, /磁碟忙碌/);
  fail = false;
  await s.retry();
  assert.equal(s.status.state, 'saved');
  assert.equal(st.file.positions[0].name, 'A');
});

test('較新版本的資料檔會被拒絕，避免損壞', () => {
  assert.throws(() => normalize({ ...emptyData(), schemaVersion: 999 }), TooNewError);
  assert.throws(() => normalize({ app: 'other' }), /不是本程式/);
  assert.throws(() => normalize(null), /不是本程式/);
});

test('replaceAll（還原/匯入）保留較大的版本號並存檔', async () => {
  const { st, s } = await mk();
  s.addPosition('現在的');
  await s.flush();
  const old = { ...emptyData(), revision: 1, positions: [{ id: 1, name: '舊的', note: '', active: true, order: 1 }] };
  s.replaceAll(old);
  await s.flush();
  assert.equal(st.file.positions[0].name, '舊的');
  assert.ok(st.file.revision > 1);
});

test('PWA：快取清單涵蓋所有程式檔，且版本號一致', () => {
  const root = new URL('..', import.meta.url).pathname;
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const ver = readFileSync(join(root, 'js/version.js'), 'utf8');
  assert.equal(sw.match(/const VERSION = '([^']+)'/)[1], ver.match(/APP_VERSION = '([^']+)'/)[1]);
  const listed = new Set([...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [relative(root, p)];
  });
  for (const f of [...walk(join(root, 'js')), ...walk(join(root, 'css')), ...walk(join(root, 'icons')), 'index.html', 'manifest.webmanifest']) {
    assert.ok(listed.has(f), `sw.js 的 ASSETS 缺少 ${f}`);
  }
  for (const f of listed) {
    if (f && f !== 'CACHE') statSync(join(root, f)); // 列出的檔案都存在
  }
});
