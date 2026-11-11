// 最精簡的 .xlsx 讀寫（不依賴任何外部套件）。
// 寫入：支援字型、底色、框線、對齊、合併儲存格、欄寬列高、隱藏工作表、隱藏格線。
// 讀取：支援一般 Excel 儲存的檔案（共用字串、內嵌字串、合併儲存格、工作表狀態）。
import { makeZip, readZip, utf8, fromUtf8 } from './zip.js';

export function colName(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]), c };
}

const esc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function unesc(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------- 樣式表
export class StyleBook {
  constructor() {
    this.fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
    this.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    this.borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    this.cache = new Map();
  }
  _idx(list, xml) { let i = list.indexOf(xml); if (i < 0) { list.push(xml); i = list.length - 1; } return i; }
  /** style: { font:{name,size,bold,underline}, fill:'RRGGBB', border:boolean, align:{h,v,wrap} } */
  add(style) {
    const key = JSON.stringify(style);
    if (this.cache.has(key)) return this.cache.get(key);
    const f = style.font || {};
    const fontXml = `<font>${f.bold ? '<b/>' : ''}${f.underline ? '<u/>' : ''}<sz val="${f.size || 11}"/><name val="${esc(f.name || 'Calibri')}"/>` +
      (f.name && /[^\u0000-\u007f]/.test(f.name) ? '<charset val="136"/>' : '') + '</font>';
    const fontId = this._idx(this.fonts, fontXml);
    const fillId = style.fill
      ? this._idx(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${style.fill}"/><bgColor indexed="64"/></patternFill></fill>`)
      : 0;
    const borderId = style.border
      ? this._idx(this.borders, '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>')
      : 0;
    const a = style.align;
    const xf = `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1"${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${a ? ' applyAlignment="1"' : ''}>` +
      (a ? `<alignment${a.h ? ` horizontal="${a.h}"` : ''}${a.v ? ` vertical="${a.v}"` : ''}${a.wrap ? ' wrapText="1"' : ''}/>` : '') + '</xf>';
    const id = this._idx(this.xfs, xf);
    this.cache.set(key, id);
    return id;
  }
  xml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }
}

// ---------------------------------------------------------------- 寫入
/**
 * @param {{ name:string, hidden?:boolean, showGrid?:boolean,
 *           cols?: Record<number, number>,           欄寬（字元數），key 為 1 起算的欄
 *           rowHeights?: Record<number, number>,     列高（點）
 *           cells: {r:number, c:number, v?:string|number|null, s?:number}[],
 *           merges?: string[] }[]} sheets
 * @param {StyleBook} styles
 * @returns {Uint8Array}
 */
export function writeXlsx(sheets, styles) {
  const files = [];
  files.push({ name: '[Content_Types].xml', data: utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>') });
  files.push({ name: '_rels/.rels', data: utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>') });
  files.push({ name: 'xl/workbook.xml', data: utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
    sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>') });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>') });
  files.push({ name: 'xl/styles.xml', data: utf8(styles.xml()) });

  sheets.forEach((sheet, i) => {
    const byRow = new Map();
    let maxR = 1; let maxC = 1;
    for (const cell of sheet.cells) {
      if (!byRow.has(cell.r)) byRow.set(cell.r, []);
      byRow.get(cell.r).push(cell);
      maxR = Math.max(maxR, cell.r); maxC = Math.max(maxC, cell.c);
    }
    const rows = [...byRow.keys()].sort((a, b) => a - b).map((r) => {
      const cells = byRow.get(r).sort((a, b) => a.c - b.c).map((cell) => {
        const ref = `${colName(cell.c)}${r}`;
        const s = cell.s ? ` s="${cell.s}"` : '';
        const v = cell.v;
        if (v === null || v === undefined || v === '') return `<c r="${ref}"${s}/>`;
        if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
        const str = String(v);
        const keep = /^\s|\s$|\n/.test(str) ? ' xml:space="preserve"' : '';
        return `<c r="${ref}"${s} t="inlineStr"><is><t${keep}>${esc(str)}</t></is></c>`;
      }).join('');
      const h = sheet.rowHeights && sheet.rowHeights[r];
      return `<row r="${r}"${h ? ` ht="${h}" customHeight="1"` : ''}>${cells}</row>`;
    }).join('');
    const colsXml = sheet.cols
      ? '<cols>' + Object.entries(sheet.cols).sort((a, b) => a[0] - b[0])
        .map(([c, w]) => `<col min="${c}" max="${c}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
      : '';
    const merges = sheet.merges && sheet.merges.length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (sheet.printFit ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '') +
      `<dimension ref="A1:${colName(maxC)}${maxR}"/>` +
      `<sheetViews><sheetView workbookViewId="0"${sheet.showGrid === false ? ' showGridLines="0"' : ''}${i === 0 ? ' tabSelected="1"' : ''}/></sheetViews>` +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      colsXml + `<sheetData>${rows}</sheetData>` + merges +
      (sheet.printFit ? '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : '') +
      '</worksheet>';
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(xml) });
  });
  return makeZip(files);
}

// ---------------------------------------------------------------- 讀取
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unesc(m[2]);
  return out;
}

/** @returns {Promise<{name:string, state:string, get:(r:number,c:number)=>any, maxRow:number, maxCol:number, merges:{r1,c1,r2,c2}[]}[]>} */
export async function readXlsx(bytes) {
  const zip = await readZip(bytes);
  const text = (name) => (zip.has(name) ? fromUtf8(zip.get(name)) : null);
  const wb = text('xl/workbook.xml');
  if (!wb) throw new Error('這不是有效的 Excel 檔案（缺少活頁簿資料）');
  const rels = new Map();
  for (const m of (text('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    rels.set(a.Id, a.Target);
  }
  const shared = [];
  const sst = text('xl/sharedStrings.xml');
  if (sst) {
    for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const inner = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      shared.push([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join(''));
    }
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    let target = rels.get(a['r:id']) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = text(target);
    if (xml === null) continue;
    const cells = new Map();
    let maxRow = 0; let maxCol = 0;
    for (const cm of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      if (!ca.r || cm[2] === undefined) continue;
      const { r, c } = parseRef(ca.r);
      const inner = cm[2];
      let val = null;
      if (ca.t === 'inlineStr') {
        val = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join('');
      } else {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        if (vm) {
          const raw = unesc(vm[1]);
          if (ca.t === 's') val = shared[Number(raw)] ?? '';
          else if (ca.t === 'str' || ca.t === 'e') val = raw;
          else if (ca.t === 'b') val = raw === '1';
          else val = Number(raw);
        }
      }
      if (val === null || val === '') continue;
      cells.set(`${r},${c}`, val);
      maxRow = Math.max(maxRow, r); maxCol = Math.max(maxCol, c);
    }
    const merges = [...xml.matchAll(/<mergeCell\b[^>]*>/g)].map((mm) => {
      const [a1, a2] = attrs(mm[0]).ref.split(':');
      const p1 = parseRef(a1); const p2 = parseRef(a2 || a1);
      return { r1: p1.r, c1: p1.c, r2: p2.r, c2: p2.c };
    });
    sheets.push({ name: a.name, state: a.state || 'visible', get: (r, c) => cells.get(`${r},${c}`) ?? null, maxRow, maxCol, merges });
  }
  return sheets;
}
