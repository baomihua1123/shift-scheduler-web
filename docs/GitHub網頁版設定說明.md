# 把網頁版放到 GitHub Pages（只需要做一次）

做完之後會得到一個網址，所有電腦用 Chrome 開啟這個網址就能使用，不需要下載、不需要安裝。

> 公開的只有「程式本身」。**人員姓名、班表等資料完全不會上傳**，只存在各台電腦自己選的資料夾裡。

## 一、建立專案並上傳

1. 登入 https://github.com ，右上角「＋」→ **New repository**。
2. Repository name 填 `shift-scheduler-web`（英文），選 **Public**，按 **Create repository**。
3. 在新專案頁面點 **uploading an existing file**（或 Add file → Upload files）。
4. 把壓縮檔解開，將資料夾**裡面的所有內容**（`index.html`、`sw.js`、`manifest.webmanifest`、`js`、`css`、`icons`、`docs`…）整批拖進網頁。
   - 這一版沒有隱藏資料夾，可以直接拖曳上傳。
5. 頁面下方按 **Commit changes**。

## 二、開啟網頁功能（GitHub Pages）

1. 專案上方點 **Settings**（設定）→ 左側 **Pages**。
2. 「Build and deployment」→ Source 選 **Deploy from a branch**。
3. Branch 選 **main**，資料夾選 **/ (root)**，按 **Save**。
4. 等 1～2 分鐘，重新整理這個頁面，上方會出現：
   `Your site is live at https://（您的帳號）.github.io/shift-scheduler-web/`
5. 這個網址就是程式的網址，請記下來給使用者。

## 三、每台電腦的使用方式

1. 用 **Chrome** 開啟上面的網址。
2. 第一次使用：按「選擇資料夾」，建議在「文件」裡新增「排班資料」資料夾並選它，瀏覽器詢問時選「允許」。
3. 安裝到桌面（建議）：網址列右側會出現「安裝」圖示（或右上角 ⋮ 選單裡有「安裝短期活動排班系統」），按下去後桌面與開始功能表會有圖示，之後雙擊就像一般軟體。

## 四、日後更新程式

1. 我提供新版壓縮檔後，解壓縮，把裡面的檔案**全部重新上傳**到 GitHub（Add file → Upload files，同名檔案會被覆蓋），按 Commit changes。
2. 等 1～2 分鐘，使用者下次開啟程式，上方會出現「有新版本可以使用」，按「立即更新」即可。資料不受影響。

## 注意事項

- 請不要更改專案名稱或帳號名稱，否則網址會變，使用者需要重新安裝。
- 網址一變，瀏覽器會視為不同的程式，**看不到原本選過的資料夾**（資料檔本身仍在資料夾裡，重新選同一個資料夾就能找回）。
