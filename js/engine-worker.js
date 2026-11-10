// 在背景執行排班計算，避免畫面凍結
import { solve } from './engine.js';

self.onmessage = (e) => {
  const { problem, options } = e.data;
  try {
    self.postMessage({ ok: true, result: solve(problem, options) });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
