// 班次切分與時間格式工具（對應桌面版的 timeslots.py）。
// 規則：
// * 全活動使用同一個班次時長，從每天開始時間往後切。
// * 有共同休息時，休息前後各自獨立切分，班次不會跨越休息時間。
// * 每一段最後剩餘的時間：小於「班次時長 × mergeThreshold（預設 0.5）」就併入上一班，否則單獨成一班；
//   若某一段本身就短於一班（沒有上一班可併），則單獨成一班。

export function parseHM(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''));
  if (!m) throw new Error(`時間格式錯誤：${text}（應為 HH:MM）`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) throw new Error(`時間超出範圍：${text}`);
  return h * 60 + mi;
}

export function fmtHM(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function dateLabel(iso) {
  const [, m, d] = iso.split('-');
  return `${m}月${d}日`;
}

export function sheetName(iso) { return iso.replaceAll('-', ''); }

export function timeRangeLabel(start, end) { return `${fmtHM(start)}~${fmtHM(end)}`; }

/**
 * @param {number} start 當天第幾分鐘
 * @param {number} end
 * @param {number} shiftMinutes
 * @param {{label:string,start:number,end:number}[]} breaks
 * @returns {{kind:'shift'|'break', start:number, end:number, label:string, segmentNo:number, isMergedTail:boolean}[]}
 */
export function buildDayLayout(start, end, shiftMinutes, breaks = [], mergeThreshold = 0.5) {
  if (!(shiftMinutes > 0)) throw new Error('班次時長必須大於 0 分鐘');
  if (end <= start) throw new Error('結束時間必須晚於開始時間');

  const ordered = [...breaks].sort((a, b) => a.start - b.start || a.end - b.end);
  let prevEnd = null;
  for (const b of ordered) {
    if (b.end <= b.start) throw new Error(`休息時間「${b.label}」的結束時間必須晚於開始時間`);
    if (b.start < start || b.end > end) {
      throw new Error(`休息時間「${b.label}」(${timeRangeLabel(b.start, b.end)}) 超出工作時間範圍`);
    }
    if (prevEnd !== null && b.start < prevEnd) throw new Error('休息時間之間不可重疊');
    prevEnd = b.end;
  }

  const segments = [];
  let cursor = start;
  for (const b of ordered) {
    if (b.start > cursor) segments.push([cursor, b.start]);
    cursor = b.end;
  }
  if (end > cursor) segments.push([cursor, end]);
  if (!segments.length) throw new Error('扣除休息時間後沒有可排班的時段');

  const items = [
    ...segments.map((seg) => ({ at: seg[0], kind: 'seg', seg })),
    ...ordered.map((b) => ({ at: b.start, kind: 'brk', b })),
  ].sort((a, b) => a.at - b.at);

  const rows = [];
  let segNo = 0;
  for (const it of items) {
    if (it.kind === 'seg') {
      rows.push(...sliceSegment(it.seg[0], it.seg[1], shiftMinutes, mergeThreshold, segNo));
      segNo += 1;
    } else {
      rows.push({ kind: 'break', start: it.b.start, end: it.b.end, label: it.b.label, segmentNo: 0, isMergedTail: false });
    }
  }
  return rows;
}

function sliceSegment(segStart, segEnd, step, threshold, segNo) {
  const length = segEnd - segStart;
  const full = Math.floor(length / step);
  const rem = length - full * step;
  const mk = (s, e, merged = false) => ({ kind: 'shift', start: s, end: e, label: '', segmentNo: segNo, isMergedTail: merged });
  if (full === 0) return [mk(segStart, segEnd)];
  const out = [];
  for (let i = 0; i < full; i++) out.push(mk(segStart + i * step, segStart + (i + 1) * step));
  if (rem > 0) {
    if (rem < step * threshold) {
      const last = out[out.length - 1];
      out[out.length - 1] = mk(last.start, segEnd, true);
    } else {
      out.push(mk(segEnd - rem, segEnd));
    }
  }
  return out;
}

// 每個班次在「當天時間軸」的位置；休息視為一個一定在休息的虛擬位置，所以休息前後的班次不算連續
export function timelinePositions(rows) {
  const tpos = [];
  let counter = 0;
  for (const r of rows) {
    if (r.kind === 'shift') tpos.push(counter);
    counter += 1;
  }
  return { tpos, length: counter };
}
