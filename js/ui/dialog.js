// 對話框小工具（使用原生 <dialog>）
import { h } from '../util.js';

/**
 * @param {{title:string, content?:Node|string, buttons?:Array<{id:string,label:string,kind?:string,validate?:()=>string|void}>}} opts
 * @returns {Promise<string>} 被按下的按鈕 id；按 Esc 或點背景為 'cancel'
 */
export function openDialog({ title, content, buttons }) {
  return new Promise((resolve) => {
    const errorBox = h('div', { class: 'dlg-error' });
    const btns = (buttons || [{ id: 'ok', label: '確定', kind: 'primary' }]).map((b) =>
      h('button', {
        class: `btn ${b.kind || ''}`,
        type: 'button',
        dataset: { id: b.id },
        onclick: () => {
          if (b.validate) {
            const msg = b.validate();
            if (msg) { errorBox.textContent = msg; return; }
          }
          close(b.id);
        },
      }, b.label));
    const body = h('div', { class: 'dlg-body' }, content);
    const dlg = h('dialog', null,
      h('div', { class: 'dlg-head' }, title),
      body, errorBox,
      h('div', { class: 'dlg-foot' }, btns));
    let closed = false;
    function close(id) {
      if (closed) return;
      closed = true;
      dlg.close();
      dlg.remove();
      resolve(id);
    }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close('cancel'); });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input, select, textarea');
    if (first) first.focus();
  });
}

export async function confirmDialog(message, { title = '請確認', okLabel = '確定', danger = false } = {}) {
  const r = await openDialog({
    title, content: message,
    buttons: [{ id: 'cancel', label: '取消' }, { id: 'ok', label: okLabel, kind: danger ? 'danger' : 'primary' }],
  });
  return r === 'ok';
}

export function alertDialog(message, title = '提醒') {
  return openDialog({ title, content: message, buttons: [{ id: 'ok', label: '知道了', kind: 'primary' }] });
}
