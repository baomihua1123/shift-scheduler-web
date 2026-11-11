// 班表與人員名單的 Excel 匯出入（對應桌面版的 excel_io.py）。
// 班表檔格式（比照使用者提供的附圖）：
// * 每個工作日一個工作表，名稱為日期（YYYYMMDD）；左上角是日期（例如「11月07日」），上方一列是崗位，左側一欄是時段。
// * 另有「人員班次統計」工作表：姓名為欄，各日期與「總計」為列。
// * 隱藏的 _data 工作表保存活動設定，匯入時可還原成專案。
import { writeXlsx, readXlsx, StyleBook, colName } from './xlsx.js';
import { dateLabel, sheetName, parseHM } from './timeslots.js';
import { viewStats } from './event-model.js';

export const FORMAT_TAG = 'shift-scheduler-web';
export const DATA_SHEET = '_data';
export const STATS_SHEET = '人員班次統計';
export const STAFF_SHEET = '人員名單';
export const FONT_NAME = '標楷體';
export const FONT_SIZE = 16;          // 一般內容（比原先預定的 14 大一號）
export const TITLE_SIZE = 18;
export const ALT_FILL = 'EBF1DE';     // 交替底色
export const PLAIN_FILL = 'FFFFFF';
const BREAK_FILL = 'D9D9D9';

const TIME_RE = /(\d{1,2}):(\d{2})\s*[~～〜\-–—]\s*(\d{1,2}):(\d{2})/;
const pad = (n) => String(n).padStart(2, '0');
const hm = (h, m) => `${pad(Number(h))}:${m}`;

// ---------------------------------------------------------------- 匯出
/**
 * @param view  班表檢視（buildView 的結果）：{ positions:[{id,name,headcount}], days:[{date, rows}], staffOrder }
 * @param meta  活動設定（buildMeta 的結果），寫入隱藏工作表供匯入還原
 * @returns {Uint8Array}
 */
export function exportSchedule(view, meta) {
  const sb = new StyleBook();
  const base = { name: FONT_NAME, size: FONT_SIZE };
  const center = { h: 'center', v: 'center', wrap: true };
  const sTitle = sb.add({ font: { ...base, size: TITLE_SIZE, bold: true, underline: true }, border: true, align: center });
  const sHead = sb.add({ font: { ...base, bold: true }, border: true, align: center });
  const sAlt = sb.add({ font: base, fill: ALT_FILL, border: true, align: center });
  const sPlain = sb.add({ font: base, fill: PLAIN_FILL, border: true, align: center });
  const sBreak = sb.add({ font: base, fill: BREAK_FILL, border: true, align: center });

  const totalCols = view.positions.reduce((a, p) => a + p.headcount, 0);
  const sheets = [];

  for (const day of view.days) {
    const cells = [];
    const merges = [];
    const rowHeights = { 1: 36 };
    cells.push({ r: 1, c: 1, v: dateLabel(day.date), s: sTitle });
    let col = 2;
    for (const p of view.positions) {
      for (let k = 0; k < p.headcount; k++) cells.push({ r: 1, c: col + k, v: k === 0 ? p.name : null, s: sHead });
      if (p.headcount > 1) merges.push(`${colName(col)}1:${colName(col + p.headcount - 1)}1`);
      col += p.headcount;
    }
    let r = 2;
    let shiftIdx = 0;
    for (const row of day.rows) {
      rowHeights[r] = 32;
      if (row.kind === 'break') {
        cells.push({ r, c: 1, v: `${row.start}~${row.end}`, s: sBreak });
        for (let c = 2; c < 2 + totalCols; c++) cells.push({ r, c, v: c === 2 ? (row.label || '休息') : null, s: sBreak });
        if (totalCols > 1) merges.push(`B${r}:${colName(1 + totalCols)}${r}`);
      } else {
        const st = shiftIdx % 2 === 0 ? sAlt : sPlain;
        shiftIdx += 1;
        cells.push({ r, c: 1, v: `${row.start}~${row.end}`, s: st });
        let c = 2;
        for (const p of view.positions) {
          const lst = row.cells[p.id] || [];
          for (let k = 0; k < p.headcount; k++) { cells.push({ r, c, v: lst[k] ? lst[k].name : null, s: st }); c += 1; }
        }
      }
      r += 1;
    }
    const cols = { 1: 24 };
    for (let c = 2; c < 2 + totalCols; c++) cols[c] = 18;
    sheets.push({ name: sheetName(day.date), showGrid: false, printFit: true, cols, rowHeights, cells, merges });
  }

  // 人員班次統計
  const st = viewStats(view);
  const cells = [{ r: 1, c: 1, v: '日期', s: sHead }];
  st.names.forEach((n, j) => cells.push({ r: 1, c: j + 2, v: n, s: sHead }));
  st.dates.forEach((dt, i) => {
    cells.push({ r: i + 2, c: 1, v: dateLabel(dt), s: sPlain });
    st.names.forEach((n, j) => cells.push({ r: i + 2, c: j + 2, v: st.table.get(n)[dt], s: sPlain }));
  });
  const totalRow = st.dates.length + 2;
  cells.push({ r: totalRow, c: 1, v: '總計', s: sHead });
  st.names.forEach((n, j) => cells.push({ r: totalRow, c: j + 2, v: Object.values(st.table.get(n)).reduce((a, b) => a + b, 0), s: sHead }));
  const statCols = { 1: 16 };
  st.names.forEach((_n, j) => { statCols[j + 2] = 14; });
  const rowHeights = {};
  for (let i = 1; i <= totalRow; i++) rowHeights[i] = 30;
  sheets.push({ name: STATS_SHEET, showGrid: false, printFit: true, cols: statCols, rowHeights, cells });

  // 隱藏資料（還原專案用）
  const assignments = [];
  for (const day of view.days) {
    for (const row of day.rows) {
      if (row.kind !== 'shift') continue;
      for (const p of view.positions) {
        (row.cells[p.id] || []).forEach((c, k) => {
          if (c) assignments.push({ date: day.date, start: row.start, end: row.end, position: p.name, k, staff: c.name });
        });
      }
    }
  }
  const payload = JSON.stringify({ format: FORMAT_TAG, version: 1, meta, assignments });
  const dataCells = [];
  for (let i = 0; i < payload.length; i += 30000) dataCells.push({ r: i / 30000 + 1, c: 1, v: payload.slice(i, i + 30000) });
  sheets.push({ name: DATA_SHEET, hidden: true, cells: dataCells });

  return writeXlsx(sheets, sb);
}

// ---------------------------------------------------------------- 匯入（班表）
function isoFromSheetName(title) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(title).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

// 解析單一日期工作表：回傳 { positions:[{name, headcount}], rows:[{kind,start,end,label,cells:[{pos,k,name}]}] }
function parseDaySheet(ws) {
  const colMap = new Map();
  const positions = [];
  let current = null;
  let k = 0;
  for (let c = 2; c <= ws.maxCol; c++) {
    const v = text(ws.get(1, c));
    if (v) { current = v; k = 0; positions.push({ name: v, headcount: 1 }); }
    else if (current !== null) { k += 1; positions[positions.length - 1].headcount = k + 1; }
    else continue;
    colMap.set(c, { pos: current, k });
  }
  const mergedRows = new Set(ws.merges.filter((m) => m.r1 === m.r2 && m.c1 === 2 && m.c2 >= 3).map((m) => m.r1));
  const rows = [];
  for (let r = 2; r <= ws.maxRow; r++) {
    const m = TIME_RE.exec(text(ws.get(r, 1)));
    if (!m) continue;
    const start = hm(m[1], m[2]); const end = hm(m[3], m[4]);
    const first = text(ws.get(r, 2));
    const isBreak = mergedRows.has(r) || (colMap.size <= 1 && /休息|午餐|晚餐/.test(first));
    if (isBreak) { rows.push({ kind: 'break', start, end, label: first || '休息', cells: [] }); continue; }
    rows.push({
      kind: 'shift', start, end, label: '',
      cells: [...colMap].map(([c, info]) => ({ pos: info.pos, k: info.k, name: text(ws.get(r, c)) })),
    });
  }
  return { positions, rows };
}

function readPackage(sheets) {
  const ws = sheets.find((s) => s.name === DATA_SHEET);
  if (!ws) return null;
  let payload = '';
  for (let r = 1; r <= ws.maxRow; r++) { const v = ws.get(r, 1); if (v) payload += String(v); }
  try {
    const data = JSON.parse(payload);
    return data && data.format === FORMAT_TAG ? data : null;
  } catch { return null; }
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{meta:object, assignments:object[], warnings:string[], source:'package'|'layout'}>}
 */
export async function readEventWorkbook(bytes, defaultName = '匯入的活動') {
  const sheets = await readXlsx(bytes);
  const pkg = readPackage(sheets);
  const daySheets = new Map();
  for (const ws of sheets) { const iso = isoFromSheetName(ws.name); if (iso) daySheets.set(iso, ws); }

  // 本程式匯出的檔案：設定以隱藏資料為準，班表以可見工作表為準（保留在 Excel 裡手動修改的姓名）
  if (pkg) {
    const meta = pkg.meta;
    const out = { meta, assignments: [], warnings: [], source: 'package' };
    const validPos = new Set((meta.positions || []).map((p) => p.name));
    for (const d of meta.days || []) {
      const ws = daySheets.get(d.date);
      const parsed = ws ? parseDaySheet(ws) : { rows: [] };
      const shiftRows = parsed.rows.filter((x) => x.kind === 'shift');
      if (!shiftRows.length) {
        out.assignments.push(...(pkg.assignments || []).filter((a) => a.date === d.date));
        out.warnings.push(`找不到 ${d.date} 的班表工作表，已改用檔案內保存的原始資料`);
        continue;
      }
      for (const row of shiftRows) {
        for (const c of row.cells) {
          if (c.name && validPos.has(c.pos)) out.assignments.push({ date: d.date, start: row.start, end: row.end, position: c.pos, k: c.k, staff: c.name });
        }
      }
    }
    return out;
  }

  // 一般 Excel：依版面盡力解析
  if (!daySheets.size) throw new Error('找不到任何以日期（YYYYMMDD）命名的工作表，無法匯入班表');
  const out = { meta: {}, assignments: [], warnings: [], source: 'layout' };
  let positions = null;
  const daysMeta = [];
  const durations = new Map();
  const seen = [];
  for (const iso of [...daySheets.keys()].sort()) {
    const { positions: pos, rows } = parseDaySheet(daySheets.get(iso));
    const shiftRows = rows.filter((x) => x.kind === 'shift');
    if (!shiftRows.length) { out.warnings.push(`工作表 ${iso.replaceAll('-', '')} 內沒有可辨識的時段列，已略過`); continue; }
    if (!positions) positions = pos;
    else if (pos.map((p) => p.name).join('|') !== positions.map((p) => p.name).join('|')) out.warnings.push(`工作表 ${iso.replaceAll('-', '')} 的崗位與第一天不同，以第一天為準`);
    const validPos = new Set(positions.map((p) => p.name));
    for (const row of shiftRows) {
      const dur = parseHM(row.end) - parseHM(row.start);
      durations.set(dur, (durations.get(dur) || 0) + 1);
      for (const c of row.cells) {
        if (!c.name || !validPos.has(c.pos)) continue;
        if (!seen.includes(c.name)) seen.push(c.name);
        out.assignments.push({ date: iso, start: row.start, end: row.end, position: c.pos, k: c.k, staff: c.name });
      }
    }
    daysMeta.push({
      date: iso,
      start: rows.map((x) => x.start).sort()[0],
      end: rows.map((x) => x.end).sort().at(-1),
      breaks: rows.filter((x) => x.kind === 'break').map((x) => ({ label: x.label, start: x.start, end: x.end })),
    });
  }
  if (!positions || !daysMeta.length) throw new Error('工作表內容無法辨識，請確認格式是否與本程式匯出的班表相同');
  const shiftMinutes = [...durations].sort((a, b) => b[1] - a[1])[0][0];
  out.meta = {
    name: defaultName, shiftMinutes, mergeThreshold: 0.5, days: daysMeta,
    positions: positions.map((p) => ({ name: p.name, headcount: p.headcount, dedicated: null })),
    attendees: seen.map((n) => ({ name: n, positions: [] })),
  };
  out.warnings.push('此檔案不是本程式匯出的完整檔，已依版面盡力解析；請確認班次與人員是否正確。');
  return out;
}

// ---------------------------------------------------------------- 人員名單
export function exportStaff(rows) {
  const sb = new StyleBook();
  const head = sb.add({ font: { name: FONT_NAME, size: 12, bold: true }, fill: ALT_FILL, border: true, align: { h: 'center', v: 'center' } });
  const body = sb.add({ font: { name: FONT_NAME, size: 12 }, border: true, align: { v: 'center', wrap: true } });
  const note = sb.add({ font: { name: FONT_NAME, size: 10 } });
  const cells = [
    { r: 1, c: 1, v: '姓名', s: head }, { r: 1, c: 2, v: '適用崗位', s: head }, { r: 1, c: 3, v: '備註', s: head },
  ];
  rows.forEach((row, i) => {
    cells.push({ r: i + 2, c: 1, v: row.name, s: body }, { r: i + 2, c: 2, v: row.positions.join('、'), s: body }, { r: i + 2, c: 3, v: row.note || '', s: body });
  });
  cells.push({ r: rows.length + 3, c: 1, v: '說明：適用崗位可複選，請用「、」或逗號分隔；崗位名稱需與「設定」頁籤相同（不存在的會自動新增）。', s: note });
  return writeXlsx([{ name: STAFF_SHEET, cols: { 1: 16, 2: 36, 3: 24 }, cells }], sb);
}

export async function readStaffWorkbook(bytes) {
  const sheets = await readXlsx(bytes);
  const ws = sheets.find((s) => s.state === 'visible') || sheets[0];
  if (!ws) throw new Error('檔案裡沒有工作表');
  let headerRow = null;
  const cols = {};
  for (let r = 1; r <= Math.min(ws.maxRow, 10); r++) {
    for (let c = 1; c <= ws.maxCol; c++) {
      const v = text(ws.get(r, c));
      if (['姓名', '適用崗位', '備註'].includes(v)) cols[v] = c;
    }
    if (cols['姓名']) { headerRow = r; break; }
  }
  if (headerRow === null) throw new Error('找不到「姓名」欄位，請使用本程式匯出的人員名單格式');
  const out = [];
  for (let r = headerRow + 1; r <= ws.maxRow; r++) {
    const name = text(ws.get(r, cols['姓名']));
    if (!name || name.startsWith('說明')) continue;
    const posText = cols['適用崗位'] ? text(ws.get(r, cols['適用崗位'])) : '';
    const note = cols['備註'] ? text(ws.get(r, cols['備註'])) : '';
    out.push({ name, positions: posText.split(/[、,，;；/\n]+/).map((x) => x.trim()).filter(Boolean), note });
  }
  return out;
}
