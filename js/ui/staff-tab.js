// 「人員管理」頁籤
import { h } from '../util.js';
import { openDialog, confirmDialog, alertDialog } from './dialog.js';
import { exportStaff, readStaffWorkbook } from '../excel-io.js';
import { downloadBytes, pickFile, XLSX_MIME } from './files.js';

const state = { selectedId: null, showInactive: false, search: '' };

async function staffDialog(store, staff) {
  const nameInput = h('input', { type: 'text', value: staff ? staff.name : '', placeholder: '例如：王小明' });
  const noteInput = h('input', { type: 'text', value: staff ? staff.note : '' });
  const have = new Set(staff ? staff.positionIds : []);
  const positions = store.positions({ includeInactive: true }).filter((p) => p.active || have.has(p.id));
  const boxes = positions.map((p) => ({
    p, el: h('input', { type: 'checkbox', checked: have.has(p.id) }),
  }));
  const list = positions.length
    ? h('div', { class: 'checks' }, boxes.map(({ p, el }) =>
        h('label', null, el, p.name + (p.active ? '' : '（已停用）'))))
    : h('div', { class: 'muted' }, '目前沒有崗位，請先到「設定」頁籤新增崗位。');
  const content = h('div', null,
    h('label', { class: 'field' }, h('span', null, '姓名'), nameInput),
    h('div', { class: 'field' }, h('span', { style: { fontWeight: 600, fontSize: '14px', display: 'block', marginBottom: '4px' } }, '適用崗位（可複選）'), list),
    h('label', { class: 'field' }, h('span', null, '備註'), noteInput));
  const result = await openDialog({
    title: staff ? '編輯人員' : '新增人員',
    content,
    buttons: [
      { id: 'cancel', label: '取消' },
      {
        id: 'ok', label: '儲存', kind: 'primary',
        validate: () => {
          const n = nameInput.value.trim();
          if (!n) return '請輸入姓名';
          const dup = store.staffList({ includeInactive: true }).some((x) => x.name === n && (!staff || x.id !== staff.id));
          return dup ? `已有同名的人員：${n}（若該人員已停用，請在「顯示已停用的人員」中恢復）` : '';
        },
      },
    ],
  });
  if (result !== 'ok') return null;
  return {
    name: nameInput.value,
    note: noteInput.value,
    positionIds: boxes.filter((b) => b.el.checked).map((b) => b.p.id),
  };
}

export function renderStaffTab(container, { store }) {
  const tbody = h('tbody');
  const addBtn = h('button', { class: 'btn primary' }, '新增人員');
  const editBtn = h('button', { class: 'btn' }, '編輯');
  const delBtn = h('button', { class: 'btn danger' }, '刪除');
  const restoreBtn = h('button', { class: 'btn' }, '恢復停用的人員');

  function visibleStaff() {
    const q = state.search.trim();
    return store.staffList({ includeInactive: state.showInactive })
      .filter((s) => !q || s.name.includes(q) || s.positionIds.some((id) => store.positionName(id).includes(q)));
  }

  function renderRows() {
    const list = visibleStaff();
    if (state.selectedId !== null && !list.some((s) => s.id === state.selectedId)) state.selectedId = null;
    tbody.replaceChildren();
    if (!list.length) {
      tbody.append(h('tr', null, h('td', { colspan: 4, class: 'empty' },
        store.staffList({ includeInactive: true }).length ? '沒有符合的人員' : '還沒有人員，請按「新增人員」開始建立。')));
    }
    for (const s of list) {
      const tr = h('tr', {
        class: `${s.active ? '' : 'inactive'} ${s.id === state.selectedId ? 'selected' : ''}`,
        onclick: () => { state.selectedId = s.id; renderRows(); },
        ondblclick: () => edit(),
      },
        h('td', null, s.name),
        h('td', null, s.positionIds.length
          ? s.positionIds.map((id) => h('span', { class: 'chip' }, store.positionName(id)))
          : h('span', { class: 'muted' }, '（未設定）')),
        h('td', null, s.note),
        h('td', null, s.active ? '使用中' : '已停用'));
      tbody.append(tr);
    }
    const sel = state.selectedId === null ? null : store.getStaff(state.selectedId);
    editBtn.disabled = !sel;
    delBtn.disabled = !sel || !sel.active;
    restoreBtn.disabled = !sel || sel.active;
  }

  async function add() {
    const v = await staffDialog(store, null);
    if (!v) return;
    try { state.selectedId = store.addStaff(v); } catch (e) { await alertDialog(e.message, '無法新增'); }
  }
  async function edit() {
    const s = store.getStaff(state.selectedId);
    if (!s) return;
    const v = await staffDialog(store, s);
    if (!v) return;
    try { store.updateStaff(s.id, v); } catch (e) { await alertDialog(e.message, '無法儲存'); }
  }
  async function del() {
    const s = store.getStaff(state.selectedId);
    if (!s) return;
    const ok = await confirmDialog(
      `確定要刪除「${s.name}」嗎？\n（若此人員曾參與活動，會改為「停用」以保留過往班表。）`,
      { title: '確認刪除', okLabel: '刪除', danger: true });
    if (!ok) return;
    if (store.deleteStaff(s.id) === 'deactivated') {
      await alertDialog(`「${s.name}」曾參與活動，已改為停用；過往班表不受影響。`, '已停用');
    }
  }

  async function exportList() {
    const rows = store.staffList().map((s) => ({ name: s.name, positions: s.positionIds.map((id) => store.positionName(id)), note: s.note }));
    downloadBytes('人員名單.xlsx', exportStaff(rows), XLSX_MIME);
  }
  function downloadTemplate() {
    const names = store.positions().map((p) => p.name).slice(0, 2);
    downloadBytes('人員名單範本.xlsx', exportStaff([{ name: '王小明（範例，請刪除）', positions: names.length ? names : ['導播'], note: '' }]), XLSX_MIME);
  }
  async function importList() {
    const file = await pickFile('.xlsx');
    if (!file) return;
    let rows;
    try { rows = await readStaffWorkbook(new Uint8Array(await file.arrayBuffer())); }
    catch (e) { await alertDialog(`無法讀取檔案：${e.message}`, '匯入失敗'); return; }
    if (!rows.length) { await alertDialog('檔案中沒有可匯入的人員。', '沒有資料'); return; }
    const ok = await confirmDialog(`共 ${rows.length} 位人員。同名者會更新其適用崗位，確定匯入嗎？`, { title: '確認匯入', okLabel: '匯入' });
    if (!ok) return;
    try {
      const rep = store.importStaffRows(rows);
      await alertDialog(`新增 ${rep.added} 位、更新 ${rep.updated} 位。` + (rep.warnings.length ? `\n\n${rep.warnings.slice(0, 15).join('\n')}` : ''), '匯入完成');
    } catch (e) { await alertDialog(e.message, '匯入失敗'); }
  }

  addBtn.onclick = add;
  editBtn.onclick = edit;
  delBtn.onclick = del;
  restoreBtn.onclick = () => { if (state.selectedId !== null) store.setStaffActive(state.selectedId, true); };

  const search = h('input', {
    type: 'search', placeholder: '搜尋姓名或崗位', value: state.search, style: { maxWidth: '240px' },
    oninput: (e) => { state.search = e.target.value; renderRows(); },
  });
  const showInactive = h('input', {
    type: 'checkbox', checked: state.showInactive,
    onchange: (e) => { state.showInactive = e.target.checked; renderRows(); },
  });

  container.replaceChildren(
    h('div', { class: 'card' },
      h('h2', null, '人員管理'),
      h('p', { class: 'muted small' }, '新增人員並勾選適用的崗位（可複選）。人員資料存放在您選擇的資料夾，所有活動都可以使用。'),
      h('div', { class: 'toolbar' }, addBtn, editBtn, delBtn, restoreBtn, h('span', { class: 'spacer' }),
        h('button', { class: 'btn', id: 'staff-import', onclick: importList }, '從 Excel 匯入名單'),
        h('button', { class: 'btn', id: 'staff-export', onclick: exportList }, '匯出名單'),
        h('button', { class: 'btn', onclick: downloadTemplate }, '下載匯入範本')),
      h('div', { class: 'toolbar' }, search,
        h('label', { class: 'small' }, showInactive, ' 顯示已停用的人員')),
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, '姓名'), h('th', null, '適用崗位'), h('th', null, '備註'), h('th', null, '狀態'))),
        tbody)));
  renderRows();
}
