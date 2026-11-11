# 短期活動排班系統（網頁版）

純靜態網頁（不需編譯、不需伺服器），可放在 GitHub Pages。資料自動存到使用者選的資料夾（File System Access API）。

- 使用者說明：`docs/使用說明.md`
- 架設說明：`docs/GitHub網頁版設定說明.md`

## 開發與測試
```
node --test tests/store.test.mjs tests/engine.test.mjs tests/events.test.mjs tests/excel.test.mjs   # 單元測試（資料、排班引擎、活動、Excel）
LC_ALL=C.UTF-8 node tests/e2e.mjs          # 真實瀏覽器測試：資料夾、自動存檔、備份（需要 playwright 與 Chromium）
LC_ALL=C.UTF-8 node tests/e2e-events.mjs   # 真實瀏覽器測試：活動、排班、手動調整、定稿、Excel、離線
```
更新程式時，請同時修改 `sw.js` 的 `VERSION` 與 `js/version.js` 的 `APP_VERSION`（單元測試會檢查兩者一致、且快取清單涵蓋所有檔案）。
