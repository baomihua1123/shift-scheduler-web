// 右上角的存檔狀態標示
import { h, fmtTime } from '../util.js';

export function createStatusBadge({ onRetry, onConflict, onReauthorize }) {
  const el = h('span', { class: 'badge', id: 'save-status' });
  function render(status, extra = {}) {
    el.className = 'badge';
    el.replaceChildren();
    if (extra.needAuth) {
      el.classList.add('warn');
      el.append('需要授權資料夾 ', h('button', { class: 'btn small', onclick: onReauthorize }, '點一下授權'));
      return;
    }
    switch (status.state) {
      case 'saving':
        el.classList.add('ok'); el.textContent = '儲存中…'; break;
      case 'saved':
        el.classList.add('ok');
        el.textContent = status.savedAt ? `✓ 已自動存檔 ${fmtTime(status.savedAt)}` : '✓ 已自動存檔';
        break;
      case 'conflict':
        el.classList.add('bad');
        el.append('資料夾內的資料已被更改 ', h('button', { class: 'btn small', onclick: onConflict }, '處理'));
        break;
      case 'error':
        el.classList.add('bad');
        el.append(`存檔失敗：${status.message || ''} `, h('button', { class: 'btn small', onclick: onRetry }, '重試'));
        break;
      default:
        el.textContent = '尚未連接資料夾';
    }
  }
  return { el, render };
}
