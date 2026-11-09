// 第一次使用 / 需要授權 / 瀏覽器不支援 / 已有其他視窗 等全螢幕提示
import { h } from '../util.js';

export function unsupportedScreen() {
  return h('div', { class: 'fullscreen' },
    h('h2', null, '請改用 Chrome 或 Edge 開啟'),
    h('p', null, '本程式需要把資料自動存到您電腦上的資料夾，這個功能目前只有 Chrome 與 Edge 瀏覽器支援。'),
    h('p', { class: 'muted' }, '您目前使用的瀏覽器不支援，請用 Chrome 或 Edge 開啟同一個網址。'));
}

export function anotherWindowScreen() {
  return h('div', { class: 'fullscreen' },
    h('h2', null, '已經有另一個視窗在使用本程式'),
    h('p', null, '為了避免兩個視窗同時修改資料造成衝突，請關閉其他已開啟的視窗（或其他分頁）後，重新整理本頁。'));
}

export function firstRunScreen({ onChoose }) {
  return h('div', { class: 'fullscreen' },
    h('h2', null, '歡迎使用短期活動排班系統'),
    h('p', null, '請先選擇一個資料夾，之後所有人員、崗位、活動與班表都會自動存放在這個資料夾裡，不需要手動存檔，也不會上傳到網路。'),
    h('ol', null,
      h('li', null, '按下方「選擇資料夾」。'),
      h('li', null, '建議在「文件」裡新增一個名為「排班資料」的資料夾，選它。'),
      h('li', null, '瀏覽器詢問時，請選「允許」；若有「每次造訪時允許」的選項，建議選它。')),
    h('p', { class: 'muted small' }, '如果這台電腦之前用過，或是從別台電腦複製了資料夾過來，直接選那個資料夾，原有的資料就會出現。'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: onChoose }, '選擇資料夾')));
}

export function reauthorizeScreen({ folderName, onAuthorize, onChooseOther }) {
  return h('div', { class: 'fullscreen' },
    h('h2', null, '需要您點一下授權'),
    h('p', null, `為了保護您的電腦，瀏覽器每隔一段時間會要求重新確認是否允許本程式存取資料夾「${folderName}」。`),
    h('p', null, '請按下方按鈕，再在跳出的視窗中選「允許」（若有「每次造訪時允許」，建議選它）。'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: onAuthorize }, '授權並繼續'),
      h('button', { class: 'btn', onclick: onChooseOther }, '改選其他資料夾')));
}

export function messageScreen(title, message, actions = []) {
  return h('div', { class: 'fullscreen' },
    h('h2', null, title),
    h('p', null, message),
    h('div', { class: 'actions' }, actions.map((a) => h('button', { class: `btn ${a.kind || ''}`, onclick: a.onClick }, a.label))));
}
