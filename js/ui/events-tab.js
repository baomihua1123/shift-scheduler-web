// 「活動專案」頁籤：活動清單、活動設定、自動排班與班表檢視
import { h } from '../util.js';
import { openDialog, confirmDialog, alertDialog } from './dialog.js';
import {
  STATUS_LABELS, DEDICATED_CHOICES, newEventDraft, cloneEvent, validateEvent, buildProblem, engineToAssignments,
  assignmentsToEngine, buildView, viewStats, sortedDays, assignmentKey, addDays,
} from '../event-model.js';
import { analyze } from '../engine.js';
import { dateLabel } from '../timeslots.js';

const ui = {
  selectedId: null,   // 已儲存活動的 id
  creating: false,    // 正在編輯尚未儲存的新活動
  draft: null,        // 設定表單的工作副本
  dirty: false,       // 表單有尚未儲存的修改
  breaksOn: false,    // 「有共同休息時間」勾選狀態
  sub: 'settings',    // 'settings' | 'schedule'
  dayTab: 0,
  generating: false,
};

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function dateRange(ev) {
  if (!ev.days.length) return '（尚未設定日期）';
  const days = sortedDays(ev);
  const a = days[0].date; const b = days[days.length - 1].date;
  return a === b ? a : `${a} ~ ${b}`;
}

// ------------------------------------------------------------ 排班（背景執行）
function runSolver(problem) {
  const options = { timeLimit: 6 };
  const inline = async () => {
    const { solve } = await import('../engine.js');
    return solve(problem, options);
  };
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('../engine-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      inline().then(resolve, reject);
      return;
    }
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.result); else reject(new Error(e.data.error));
    };
    worker.onerror = () => { worker.terminate(); inline().then(resolve, reject); };
    worker.postMessage({ problem, options });
  });
}

// ------------------------------------------------------------ 主畫面
export function renderEventsTab(container, ctx) {
  const { store } = ctx;
  const refresh = () => renderEventsTab(container, ctx);

  // 選到的活動不存在了（被刪除、還原備份等）
  if (ui.selectedId !== null && !store.getEvent(ui.selectedId)) { ui.selectedId = null; ui.draft = null; ui.dirty = false; }
  if (!ui.creating && ui.selectedId === null) { ui.draft = null; }
  // 沒有未儲存的修改時，隨時與儲存的內容同步
  if (!ui.creating && ui.selectedId !== null && (!ui.dirty || !ui.draft || ui.draft.id !== ui.selectedId)) {
    ui.draft = cloneEvent(store.getEvent(ui.selectedId));
    ui.breaksOn = ui.draft.days.some((d) => d.breaks.length > 0);
    ui.dirty = false;
  }
  const savedEvent = ui.selectedId !== null ? store.getEvent(ui.selectedId) : null;

  async function confirmDiscard() {
    if (!ui.dirty) return true;
    return confirmDialog('目前的設定還沒有儲存，要放棄這些修改嗎？', { title: '尚未儲存', okLabel: '放棄修改', danger: true });
  }

  async function selectEvent(id) {
    if (id === ui.selectedId && !ui.creating) return;
    if (!(await confirmDiscard())) return;
    ui.creating = false; ui.selectedId = id; ui.dirty = false; ui.draft = null; ui.dayTab = 0;
    ui.sub = store.getEvent(id).status === 'draft' ? 'settings' : 'schedule';
    refresh();
  }

  async function newEvent() {
    if (!(await confirmDiscard())) return;
    ui.creating = true; ui.selectedId = null; ui.dirty = false; ui.sub = 'settings';
    ui.draft = newEventDraft(todayIso());
    ui.breaksOn = false;
    refresh();
  }

  async function copyEvent() {
    if (!savedEvent) { await alertDialog('請先在左側選擇要複製設定的活動。', '請先選擇'); return; }
    if (!(await confirmDiscard())) return;
    const nameInput = h('input', { type: 'text', value: `${savedEvent.name}（複製）` });
    const dateInput = h('input', { type: 'date', value: todayIso() });
    const r = await openDialog({
      title: '複製活動設定',
      content: h('div', null,
        h('label', { class: 'field' }, h('span', null, '新活動名稱'), nameInput),
        h('label', { class: 'field' }, h('span', null, '第一天日期'), dateInput),
        h('p', { class: 'muted small' }, '會複製：班次時長、工作時間、共同休息、所需崗位、出席人員。不會複製班表；多天活動的日期會整體平移。')),
      buttons: [
        { id: 'cancel', label: '取消' },
        { id: 'ok', label: '複製', kind: 'primary', validate: () => (nameInput.value.trim() && dateInput.value ? '' : '請填寫活動名稱與日期') },
      ],
    });
    if (r !== 'ok') return;
    try {
      const id = store.duplicateEvent(savedEvent.id, nameInput.value.trim(), dateInput.value);
      ui.creating = false; ui.selectedId = id; ui.dirty = false; ui.draft = null; ui.sub = 'settings';
      refresh();
    } catch (e) { await alertDialog(e.message, '無法複製'); }
  }

  async function deleteEvent() {
    if (!savedEvent) { await alertDialog('請先在左側選擇要刪除的活動。', '請先選擇'); return; }
    const ok = await confirmDialog(`確定要刪除活動「${savedEvent.name}」與它的班表嗎？此動作無法復原。`,
      { title: '確認刪除', okLabel: '刪除', danger: true });
    if (!ok) return;
    store.deleteEvent(savedEvent.id);
    ui.selectedId = null; ui.creating = false; ui.draft = null; ui.dirty = false;
    refresh();
  }

  // ---------------- 儲存與排班 ----------------
  async function saveDraft() {
    try { validateEvent(ui.draft); } catch (e) { await alertDialog(e.message, '設定有誤'); return null; }
    const prev = store.previewSaveEvent(ui.draft);
    if (prev.layoutChanged && prev.hasAssignments) {
      const ok = await confirmDialog(
        '修改日期、工作時間、班次時長或休息時間後，班次會重新切分，目前的班表會被清除。\n要繼續嗎？',
        { title: '將清除現有班表', okLabel: '繼續儲存', danger: true });
      if (!ok) return null;
    }
    let info;
    try { info = store.saveEvent(ui.draft); } catch (e) { await alertDialog(e.message, '無法儲存'); return null; }
    ui.creating = false; ui.selectedId = info.id; ui.dirty = false; ui.draft = null;
    refresh();
    if (info.pruned && !info.layoutChanged) {
      await alertDialog(`因為崗位或出席人員有調整，已移除 ${info.pruned} 筆不再有效的排班。請到「班表」確認，或按「重新排班」。`, '已更新');
    }
    return info.id;
  }

  async function generate() {
    if (ui.generating) return;
    const id = ui.dirty || ui.creating || !savedEvent ? await saveDraft() : savedEvent.id;
    if (id === null || id === undefined) return;
    const ev = store.getEvent(id);
    if (ev.status === 'final') { await alertDialog('請先「解除定稿」才能重新排班。'); return; }
    let built;
    try { built = buildProblem(store, ev); } catch (e) { await alertDialog(e.message, '無法排班'); return; }
    ui.generating = true;
    ui.sub = 'schedule';
    refresh();
    let result;
    try { result = await runSolver(built.problem); } catch (e) {
      result = { ok: false, errors: [`排班時發生錯誤：${e.message}`], warnings: [], notes: [] };
    }
    ui.generating = false;
    if (!result.ok) {
      ui.sub = 'settings'; // 失敗多半要回頭調整設定（人員、崗位、時間）
      refresh();
      await alertDialog(result.errors.join('\n') || '未知原因', '無法完成排班');
      return;
    }
    try {
      store.applyGeneration(id, engineToAssignments(built, result.assignments), result);
    } catch (e) { await alertDialog(e.message, '無法寫入班表'); }
    ui.dayTab = 0;
    refresh();
  }

  async function clearSchedule() {
    if (!savedEvent) return;
    const ok = await confirmDialog('要清除這個活動目前的所有排班嗎？', { title: '清除班表', okLabel: '清除', danger: true });
    if (!ok) return;
    try { store.clearAssignments(savedEvent.id, false); } catch (e) { await alertDialog(e.message, '無法清除'); }
    refresh();
  }

  // ---------------- 左側：活動清單 ----------------
  const events = store.events();
  const sidebar = h('div', { class: 'sidebar' },
    h('div', { class: 'card' },
      h('h2', null, '活動專案'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', onclick: newEvent }, '新增活動'),
        h('button', { class: 'btn', onclick: copyEvent }, '複製設定'),
        h('button', { class: 'btn danger', onclick: deleteEvent }, '刪除')),
      events.length
        ? events.map((ev) => h('div', {
            class: `event-item ${ev.id === ui.selectedId && !ui.creating ? 'selected' : ''}`,
            onclick: () => selectEvent(ev.id),
          },
            h('div', { class: 'name' }, ev.name, h('span', { class: `status-chip ${ev.status}` }, STATUS_LABELS[ev.status])),
            h('div', { class: 'meta' }, dateRange(ev))))
        : h('div', { class: 'muted small' }, ui.creating ? '' : '還沒有活動，請按「新增活動」。'),
      ui.creating ? h('div', { class: 'event-item selected' }, h('div', { class: 'name' }, '（新活動，尚未儲存）')) : null));

  // ---------------- 右側 ----------------
  let main;
  if (!ui.draft) {
    main = h('div', { class: 'card' },
      h('h2', null, '開始排班'),
      h('p', null, '請從左側選擇一個活動，或按「新增活動」建立新的活動。'),
      store.positions().length === 0 || store.staffList().length === 0
        ? h('div', { class: 'notice' }, '提醒：請先到「設定」頁籤建立崗位、到「人員管理」頁籤建立人員，再建立活動。')
        : h('p', { class: 'muted small' }, '做過的活動可以按「複製設定」，只需改日期與人員就能快速建立下一場。'))
  } else {
    const canSchedule = savedEvent !== null && !ui.creating;
    if (ui.sub === 'schedule' && !canSchedule) ui.sub = 'settings';
    main = h('div', null,
      h('div', { class: 'subtabs' },
        h('button', { class: `subtab ${ui.sub === 'settings' ? 'active' : ''}`, onclick: () => { ui.sub = 'settings'; refresh(); } }, '活動設定'),
        h('button', { class: `subtab ${ui.sub === 'schedule' ? 'active' : ''}`, disabled: !canSchedule, onclick: () => { ui.sub = 'schedule'; refresh(); } }, '班表')),
      ui.sub === 'settings' ? settingsForm({ store, refresh, saveDraft, generate }) : schedulePanel({ store, ev: savedEvent, generate, clearSchedule, refresh }));
  }

  container.replaceChildren(h('div', { class: 'split' }, sidebar, h('div', { class: 'main-panel' }, main)));
}

// ============================================================ 活動設定表單
function settingsForm({ store, refresh, saveDraft, generate }) {
  const d = ui.draft;
  const readOnly = d.status === 'final';
  const edit = (fn) => { fn(); ui.dirty = true; };

  // ---- 基本資料
  const basic = h('div', { class: 'card' },
    h('h2', null, '基本資料'),
    h('div', { class: 'form-row' },
      h('label', { class: 'field' }, h('span', null, '活動名稱'),
        h('input', { type: 'text', id: 'ev-name', value: d.name, placeholder: '例如：2026 年會', oninput: (e) => edit(() => { d.name = e.target.value; }) })),
      h('label', { class: 'field' }, h('span', null, '備註'),
        h('input', { type: 'text', value: d.note, oninput: (e) => edit(() => { d.note = e.target.value; }) }))),
    h('div', { class: 'form-row' },
      h('label', { class: 'field' }, h('span', null, '每班時長（分鐘）'),
        h('input', {
          type: 'number', id: 'ev-shift', min: 5, max: 720, step: 5, value: d.shiftMinutes,
          oninput: (e) => edit(() => { d.shiftMinutes = Number(e.target.value); }),
        })),
      h('label', { class: 'field' }, h('span', null, '休息分佈'),
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontWeight: 400 } },
          h('input', { type: 'checkbox', id: 'ev-avoid', checked: d.avoidConsecutive, onchange: (e) => edit(() => { d.avoidConsecutive = e.target.checked; }) }),
          '盡量避免連續上班（做 1 休 1）'))),
    h('p', { class: 'muted small' }, '全活動的班次時長一致。每天（或休息前後各段）最後剩餘的時間，不到一班的一半就併入上一班，否則單獨成一班。'));

  // ---- 工作日
  const dayRows = d.days.map((day, i) => h('tr', null,
    h('td', null, h('input', { type: 'date', value: day.date, onchange: (e) => { edit(() => { day.date = e.target.value; }); refresh(); } })),
    h('td', null, h('input', { type: 'time', value: day.start, onchange: (e) => edit(() => { day.start = e.target.value; }) })),
    h('td', null, h('input', { type: 'time', value: day.end, onchange: (e) => edit(() => { day.end = e.target.value; }) })),
    h('td', null, h('button', {
      class: 'btn small danger', disabled: d.days.length <= 1,
      onclick: () => { edit(() => { d.days.splice(i, 1); }); refresh(); },
    }, '刪除'))));
  const daysCard = h('div', { class: 'card' },
    h('h2', null, '工作日期與工作時間'),
    h('table', { class: 'form-table', id: 'days-table' },
      h('thead', null, h('tr', null, h('th', null, '日期'), h('th', null, '開始時間'), h('th', null, '結束時間'), h('th', null, ''))),
      h('tbody', null, dayRows)),
    h('div', { class: 'toolbar', style: { marginTop: '10px' } },
      h('button', {
        class: 'btn', id: 'add-day',
        onclick: () => {
          edit(() => {
            const last = d.days[d.days.length - 1];
            d.days.push({ date: last ? addDays(last.date, 1) : todayIso(), start: last ? last.start : '09:00', end: last ? last.end : '18:00', breaks: [] });
          });
          refresh();
        },
      }, '新增一天')));

  // ---- 共同休息
  const breakRows = [];
  d.days.forEach((day, di) => day.breaks.forEach((b, bi) => {
    breakRows.push(h('tr', null,
      h('td', null, h('select', {
        onchange: (e) => {
          const to = Number(e.target.value);
          edit(() => { const [moved] = day.breaks.splice(bi, 1); d.days[to].breaks.push(moved); });
          refresh();
        },
      }, d.days.map((x, xi) => h('option', { value: xi, selected: xi === di }, `第 ${xi + 1} 天 ${x.date ? dateLabel(x.date) : ''}`)))),
      h('td', null, h('input', { type: 'text', value: b.label, oninput: (e) => edit(() => { b.label = e.target.value; }) })),
      h('td', null, h('input', { type: 'time', value: b.start, onchange: (e) => edit(() => { b.start = e.target.value; }) })),
      h('td', null, h('input', { type: 'time', value: b.end, onchange: (e) => edit(() => { b.end = e.target.value; }) })),
      h('td', null, h('button', { class: 'btn small danger', onclick: () => { edit(() => { day.breaks.splice(bi, 1); }); refresh(); } }, '刪除'))));
  }));
  const breaksCard = h('div', { class: 'card' },
    h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontWeight: 600 } },
      h('input', {
        type: 'checkbox', id: 'ev-breaks', checked: ui.breaksOn,
        onchange: (e) => {
          ui.breaksOn = e.target.checked;
          edit(() => {
            if (ui.breaksOn) { for (const day of d.days) if (!day.breaks.length) day.breaks.push({ label: '午餐', start: '12:00', end: '13:00' }); }
            else for (const day of d.days) day.breaks = [];
          });
          refresh();
        },
      }), '有共同休息時間（例如午餐、晚餐）'),
    h('p', { class: 'muted small' }, '預設沒有。休息時間不排班，也不算連續上班；班次不會跨越休息時間。'),
    ui.breaksOn ? h('div', null,
      h('table', { class: 'form-table', id: 'breaks-table' },
        h('thead', null, h('tr', null, h('th', null, '日期'), h('th', null, '名稱'), h('th', null, '開始'), h('th', null, '結束'), h('th', null, ''))),
        h('tbody', null, breakRows)),
      h('div', { class: 'toolbar', style: { marginTop: '10px' } },
        h('button', {
          class: 'btn', id: 'add-breaks',
          onclick: () => { edit(() => { for (const day of d.days) day.breaks.push({ label: '晚餐', start: '18:00', end: '19:00' }); }); refresh(); },
        }, '為每一天新增一段休息'))) : null);

  // ---- 所需崗位
  const chosen = new Map(d.positions.map((p) => [p.positionId, p]));
  const posList = store.positions().slice();
  for (const p of store.positions({ includeInactive: true })) if (chosen.has(p.id) && !posList.some((x) => x.id === p.id)) posList.push(p);
  const posCard = h('div', { class: 'card' },
    h('h2', null, '本次所需崗位'),
    posList.length ? h('table', { class: 'form-table', id: 'pos-table' },
      h('thead', null, h('tr', null, h('th', null, '使用'), h('th', null, '崗位'), h('th', null, '每班人數'), h('th', null, '專任設定'))),
      h('tbody', null, posList.map((p) => {
        const sel = chosen.get(p.id);
        return h('tr', null,
          h('td', null, h('input', {
            type: 'checkbox', checked: Boolean(sel), dataset: { pos: p.id },
            onchange: (e) => { edit(() => {
              if (e.target.checked) d.positions.push({ positionId: p.id, headcount: 1, dedicated: null });
              else d.positions = d.positions.filter((x) => x.positionId !== p.id);
            }); refresh(); },
          })),
          h('td', null, p.name + (p.active ? '' : '（已停用）')),
          h('td', null, h('input', {
            type: 'number', min: 1, max: 20, value: sel ? sel.headcount : 1, disabled: !sel, style: { width: '80px' },
            oninput: (e) => edit(() => { if (sel) sel.headcount = Number(e.target.value); }),
          })),
          h('td', null, h('select', {
            disabled: !sel,
            onchange: (e) => edit(() => { if (sel) sel.dedicated = e.target.value === 'true' ? true : e.target.value === 'false' ? false : null; }),
          }, DEDICATED_CHOICES.map((c) => h('option', { value: String(c.value), selected: sel ? sel.dedicated === c.value : c.value === null }, c.label)))));
      }))) : h('div', { class: 'notice' }, '目前沒有崗位，請先到「設定」頁籤新增崗位。'),
    h('p', { class: 'muted small' }, '專任設定：「自動判斷」會把合格人數很少的崗位（例如只有 2 人會導播）改由這些人專任，他們不再進入其他崗位的輪替；若這樣會讓其他崗位人力過緊，會自動改為不專任。'));

  // ---- 出席人員
  const attending = new Set(d.staffIds);
  const staffList = store.staffList().slice();
  for (const s of store.staffList({ includeInactive: true })) if (attending.has(s.id) && !staffList.some((x) => x.id === s.id)) staffList.push(s);
  const staffBoxes = staffList.map((s) => ({ s, el: h('input', {
    type: 'checkbox', checked: attending.has(s.id), dataset: { staff: s.id },
    onchange: (e) => edit(() => {
      if (e.target.checked) { if (!d.staffIds.includes(s.id)) d.staffIds.push(s.id); } else d.staffIds = d.staffIds.filter((x) => x !== s.id);
    }),
  }) }));
  const setAll = (v) => { edit(() => { d.staffIds = v ? staffList.map((s) => s.id) : []; }); for (const b of staffBoxes) b.el.checked = v; };
  const staffCard = h('div', { class: 'card' },
    h('h2', null, '本次出席人員'),
    staffList.length ? h('div', null,
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn small', id: 'all-staff', onclick: () => setAll(true) }, '全選'),
        h('button', { class: 'btn small', onclick: () => setAll(false) }, '全不選')),
      h('div', { class: 'attendees', id: 'attendees' }, staffBoxes.map(({ s, el }) =>
        h('label', null, el, s.name + (s.active ? '' : '（已停用）'),
          h('span', { class: 'sub' }, `　${s.positionIds.map((id) => store.positionName(id)).join('、') || '未設定崗位'}`)))))
      : h('div', { class: 'notice' }, '目前沒有人員，請先到「人員管理」頁籤新增人員。'));

  const actions = h('div', { class: 'sticky-actions' },
    h('button', { class: 'btn', id: 'save-event', onclick: () => saveDraft() }, '儲存設定'),
    h('button', { class: 'btn primary', id: 'save-generate', onclick: () => generate() }, '儲存並產生班表'));

  const form = h('div', null,
    d.status === 'final' ? h('div', { class: 'notice info' }, '此活動已定稿，設定為唯讀。') : null,
    d.id === null ? null : h('p', { class: 'muted small' }, `狀態：${STATUS_LABELS[d.status]}${ui.dirty ? '（有尚未儲存的修改）' : ''}`),
    basic, daysCard, breaksCard, posCard, staffCard, actions);
  if (readOnly) for (const el of form.querySelectorAll('input, select, button')) el.disabled = true;
  return form;
}

// ============================================================ 班表檢視
function schedulePanel({ store, ev, generate, clearSchedule, refresh }) {
  if (!ev) return h('div', { class: 'card' }, '請先儲存活動設定。');
  const hasAssignments = Object.keys(ev.assignments || {}).length > 0;
  const view = buildView(store, ev);

  const bar = h('div', { class: 'toolbar' },
    h('button', { class: 'btn primary', id: 'gen-btn', disabled: ui.generating || ev.status === 'final', onclick: () => generate() },
      hasAssignments ? '重新排班' : '產生班表'),
    h('button', { class: 'btn', id: 'clear-btn', disabled: ui.generating || !hasAssignments || ev.status === 'final', onclick: () => clearSchedule() }, '清除班表'),
    h('span', { class: 'spacer' }),
    ui.generating ? h('span', null, h('span', { class: 'spinner' }), '排班計算中，請稍候…') : null);

  if (!view.positions.length) {
    return h('div', null, h('div', { class: 'card' }, bar, h('div', { class: 'notice' }, '尚未選擇本次所需崗位，請先到「活動設定」。')));
  }

  // 分析
  let issuesBox;
  let badCells = new Set();
  if (hasAssignments) {
    const built = buildProblem(store, ev, { includeLocked: false });
    const an = analyze(built.problem, assignmentsToEngine(built, ev));
    badCells = new Set([...an.badKeys].map((key) => {
      const [si, pid, k] = key.split('|').map(Number);
      const s = built.slots[si];
      return assignmentKey(s.date, s.start, pid, k);
    }));
    const gen = ev.lastGeneration || { warnings: [], notes: [] };
    const warnings = [...new Set([...(gen.warnings || []), ...an.warnings])];
    const items = [];
    if (!an.errors.length && !warnings.length) items.push(h('li', { class: 'ok' }, '✔ 所有班次與崗位都已排滿，且人員皆符合適用崗位。'));
    for (const t of an.errors) items.push(h('li', { class: 'err' }, `✖ ${t}`));
    for (const t of warnings) items.push(h('li', { class: 'warn' }, `⚠ ${t}`));
    for (const t of gen.notes || []) items.push(h('li', null, `ℹ ${t}`));
    issuesBox = h('div', { class: 'card' }, h('h2', null, `檢查結果（${an.errors.length} 個問題、${warnings.length} 個提醒）`), h('ul', { class: 'issues', id: 'issues' }, items));
  } else {
    issuesBox = h('div', { class: 'card' }, h('p', { class: 'muted' }, ui.generating ? '' : '尚未排班。請按「產生班表」。'));
  }

  // 每天的班表
  if (ui.dayTab >= view.days.length) ui.dayTab = 0;
  const dayTabs = h('div', { class: 'daytabs' }, view.days.map((day, i) =>
    h('button', { class: `daytab ${i === ui.dayTab ? 'active' : ''}`, dataset: { day: day.date }, onclick: () => { ui.dayTab = i; refresh(); } }, dateLabel(day.date))));
  const day = view.days[ui.dayTab];
  const totalCols = view.positions.reduce((a, p) => a + p.headcount, 0);
  const head = h('tr', null,
    h('th', { class: 'corner' }, dateLabel(day.date)),
    view.positions.map((p) => h('th', { colspan: p.headcount }, p.name)));
  let shiftIdx = 0;
  const body = day.rows.map((r) => {
    if (r.kind === 'break') {
      return h('tr', { class: 'break' }, h('td', null, `${r.start}~${r.end}`), h('td', { colspan: totalCols }, r.label));
    }
    const alt = shiftIdx % 2 === 0;
    shiftIdx += 1;
    return h('tr', { class: alt ? 'alt' : '' },
      h('td', null, `${r.start}~${r.end}`),
      view.positions.flatMap((p) => r.cells[p.id].map((c, k) => h('td', {
        class: `${badCells.has(assignmentKey(day.date, r.start, p.id, k)) ? 'bad' : ''} ${c && c.locked ? 'locked' : ''}`,
        dataset: { pos: p.name },
      }, c ? c.name : ''))));
  });
  const grid = h('div', { class: 'card' },
    dayTabs,
    h('div', { class: 'scroll-x' }, h('table', { class: 'sched', id: 'sched-table' }, h('thead', null, head), h('tbody', null, body))));

  // 統計
  const st = viewStats(view);
  const statsCard = h('div', { class: 'card' },
    h('h2', null, '人員班次統計'),
    h('div', { class: 'scroll-x' }, h('table', { class: 'stats', id: 'stats-table' },
      h('thead', null, h('tr', null, h('th', null, '日期'), st.names.map((n) => h('th', null, n)))),
      h('tbody', null,
        st.dates.map((dt) => h('tr', null, h('th', null, dateLabel(dt)), st.names.map((n) => h('td', null, st.table.get(n)[dt])))),
        h('tr', { class: 'total' }, h('th', null, '總計'), st.names.map((n) => h('td', null, Object.values(st.table.get(n)).reduce((a, b) => a + b, 0))))))));

  return h('div', null, h('div', { class: 'card' }, bar), grid, hasAssignments ? statsCard : null, issuesBox);
}

