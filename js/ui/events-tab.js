// 「活動專案」頁籤（下一階段加入完整功能）
import { h } from '../util.js';

export function renderEventsTab(container, { store }) {
  const count = store.data.events.length;
  container.replaceChildren(
    h('div', { class: 'card' },
      h('h2', null, '活動專案'),
      h('p', null, '活動設定、自動排班、班表編輯與 Excel 匯出入，將在下一階段加入。'),
      h('p', { class: 'muted small' }, count
        ? `目前資料夾裡已有 ${count} 個活動。`
        : '目前還沒有活動。請先到「設定」頁籤建立崗位，再到「人員管理」頁籤建立人員。')));
}
