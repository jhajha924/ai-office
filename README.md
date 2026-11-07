# AI 辦公室

把你電腦上所有 Claude Code 對話畫成一間 **3D 等角辦公室**：一個對話一個小組，員工帶名字、職稱、模型標記與中文狀態泡泡。底部有員工卡片（進度條、產出檔），側欄有動態牆，派出子代理時卡片之間會畫交接弧線；沒事做的員工會晃去茶水間，久了打瞌睡，光線跟著白天黑夜變。

> **English summary** — AI Office turns every Claude Code conversation on your machine into a small team in a 3D isometric office: names, job titles, model badges and status bubbles (in Traditional Chinese), staff cards with progress bars and output files, an activity feed, and hand-off arcs when sub-agents are sent out. It only reads Claude Code's local transcripts, serves on `127.0.0.1` only, and uploads nothing. Requires Node.js 24. `npm install && npm run build && npm start`, then open <http://127.0.0.1:5188/>; `npm run demo` shows a scripted demo with made-up data. Floors (e.g. a masked "work" floor) are configured in `~/.ai-office/config.json` — see `config.example.json`. Tested on Windows only.

![辦公室總覽（示範模式）](docs/辦公室總覽_工作樓.png)

- **只在本機**：伺服器只聽 `127.0.0.1`，不自動開瀏覽器，不寫 log 檔，不上傳任何東西。
- **只讀不寫**：只讀 `~/.claude/projects` 底下的對話紀錄，不寫入任何檔案。專案資料夾只有兩個例外，而且只限**沒有遮罩**的樓層：讀正在處理的 speclink／spectra 變更的 `tasks.md` 算進度；你點產出標籤時，讀那個對話今天寫過的檔案來預覽。
- **遮罩樓層**：設定成遮罩的樓層（例如公司專案），泡泡只顯示動作種類（「讀取檔案」「執行指令」），檔名、指令、子任務描述在伺服器端就去掉，不會送到瀏覽器；也不讀那些專案的任何檔案。

## 需求

- Node.js 24 以上（伺服器直接執行 TypeScript，不需要編譯伺服器）
- 已在 Windows 上測試；macOS／Linux 理論上可以執行，但沒有測試過

## 安裝與啟動

```bash
npm install
npm run build     # 產生前端畫面（web/dist），改過 web/ 底下的檔案才需要重跑
npm start         # 看你真正的 Claude Code 對話
```

主控台會印出網址，**自己用瀏覽器打開**：<http://127.0.0.1:5188/>。按 `Ctrl+C` 結束。沒有任何設定時，所有對話都在同一層「辦公室」。

| 指令 | 用途 |
|---|---|
| `npm start` | 監看 `~/.claude/projects` 的對話紀錄 |
| `npm run demo` | 示範模式：六個虛構的小組照劇本動（含工作樓與私人樓、閒置、打瞌睡、進度、產出預覽），**完全不讀任何檔案**，也不看你的設定檔 |
| `npm run build` | 建置前端 |
| `npm test` | 自動測試（vitest） |
| `npm run typecheck` | 型別檢查 |
| `npm run check:public` | 個資掃描（見「參與開發」） |
| `npm run hook:install` | 預覽要加的「等你核准」Hook（加 `-- --yes` 才真的寫入） |
| `npm run hook:uninstall` | 預覽要移除的 Hook（加 `-- --yes` 才真的移除） |

連接埠被占用時會印出中文錯誤並結束；改用其他連接埠：

```powershell
$env:AI_OFFICE_PORT = 5190; npm start     # PowerShell
```

```bash
AI_OFFICE_PORT=5190 npm start             # macOS／Linux／Git Bash
```

## 畫面怎麼看

| 位置 | 內容 |
|---|---|
| 上方 | 樓層分頁（只有一層時不顯示；橘色數字＝那層樓有幾個對話在等你）、目前樓層的「工作中 · 產出 · 等你」 |
| 中間 | 3D 辦公室：工位區、會議室、茶水間、休息區。滑鼠左鍵拖曳＝水平旋轉，滾輪＝縮放，右鍵拖曳＝平移 |
| 右側上半 | 依狀態分成「需要你／工作中／已完成」，點一列鏡頭會移到那一組 |
| 右側下半 | 動態牆：目前樓層的「完成、交接、交回、等你」，新的在上，最多 30 則 |
| 底部 | 員工卡片列：目前樓層每位員工一張，點卡片鏡頭會移到那一組 |

- **一組四個座位**：主對話坐第一個位子，子代理、技能員工坐旁邊；超過三位成員就站在走道。
- **進出**：新員工從門口走進座位，離開時走回門口。
- **名牌**：泡泡（狀態）→ 職稱（前面的圓點是模型：O＝Opus、S＝Sonnet、H＝Haiku、F＝Fable）→ 小組名稱（主對話才有：優先用 Claude Code 自動產生的對話標題，還沒有標題時用第一句話，都截到 15 字）。
- **泡泡顏色**：紫＝思考中、藍＝執行中、青＝回覆中、綠＝已完成、橘＝等你、紅＝卡住？、灰＝閒置／打瞌睡。
- **卡住？**：執行中超過 10 分鐘、或思考中超過 8 分鐘沒有新動作。只是提醒，下一個動作出現就消失。
- 一個樓層最多 12 組入座；第 13 組以後只出現在右側清單，標「未入座」。
- 對話 30 分鐘沒有新紀錄就整組離開；之後再有動作會回來，名稱不變。

### 員工卡片

![卡片列與交接弧線（示範模式）](docs/私人樓_卡片與交接弧線.png)

- **名字**：每位員工從名單（內建 40 個兩字暱稱）依身分固定配一個，重開伺服器也不會換人。
- **目前任務**：主對話＝小組名稱；子代理＝派出時的任務描述（遮罩樓層顯示「處理子任務」）；技能員工＝技能職稱。
- **進度條**：
  - 沒有遮罩的樓層裡的 speclink／spectra 對話：從技能參數、`--change` 指令或讀寫的 `openspec/changes/<名稱>/` 路徑判斷正在做哪個變更，讀它的 `tasks.md` 顯示「勾選數／總數」。
  - 算不出比例時，工作中的員工顯示來回流動的條；沒在工作就不顯示。
- **產出檔**：對話今天寫過或改過的檔案。沒有遮罩的樓層顯示檔名（最多 3 個，其餘「+N」），點檔名跳出純文字預覽（最多 256KB、二進位檔不顯示內容，按 Esc 或點外面關閉）。遮罩樓層只顯示「N 個檔案」，沒有預覽。

![產出檔預覽（示範模式）](docs/產出預覽.png)

### 交接弧線與動態牆

- 主對話派出子代理時，從主對話的卡片畫一條紅色虛線弧線到子代理的卡片，標籤如「小恩 → 小萱（資料調查員）：查本週銷售數字」；子代理交回時反方向。4 秒後淡出。
- 動態牆記「完成、交接、交回、等你」四種時刻。遮罩樓層的交接只寫「派出子任務」。

### 閒置、打瞌睡、日夜

- **閒置**（做完 3 分鐘）：員工離開座位，晃到咖啡機、微波爐、吧檯、桌球桌、沙發或書櫃；一有新工作就走回座位。
- **打瞌睡**（再過 15 分鐘）：回座坐著，頭上「打瞌睡 z z z」。
- **日夜**：依電腦時間切換白天（07–17）、黃昏（17–19）、夜晚（19–07）。想直接看某個時段，在網址後面加 `?hour=21`（0～23）。

![夜晚的遮罩樓層：打瞌睡、只顯示「1 個檔案」](docs/夜晚工作樓.png)

## 設定檔（選用）

位置：家目錄的 `.ai-office/config.json`（Windows 是 `%USERPROFILE%\.ai-office\config.json`）。**不建立也可以**。程式只讀這個檔、從不寫入；存檔後幾秒內就套用，不必重啟（`observe` 例外，要重啟）。格式寫錯時主控台印一行警告，整份退回內建預設。

最快的做法：把程式庫裡的 [`config.example.json`](config.example.json) 複製過去再改。它示範兩層樓：`C:\Projects\work\` 底下的對話進「工作樓」並遮罩，其他都進「私人樓」。

| 鍵 | 意思 | 內建預設 |
|---|---|---|
| `floors.rules` | 樓層規則：`{ "prefix": 路徑, "floor": 樓層名, "mask": 是否遮罩 }`，最長的 prefix 優先，比對不分大小寫與斜線方向 | 沒有規則 |
| `floors.default` | 都不符合時的樓層 | `{ "floor": "辦公室", "mask": false }` |
| `roster.subagents`／`roster.skills` | 子代理類型、技能名稱對應的職稱 | 內建一份（例如 `Explore`＝資料調查員、`speclink-apply`＝開發工程師） |
| `roster.names` | 員工名字名單（至少 1 個） | 40 個兩字暱稱 |
| `floorOverrides` | 某一層樓的職稱覆寫，例如 `{ "工作樓": { "skills": { "speclink-apply": "後端工程師" } } }` | 沒有 |
| `groupLabelMaxChars` | 小組名稱最多幾個字 | 15 |
| `timing` | 卡住、閒置、打瞌睡、離開的時間（毫秒） | 見 `config.example.json` |
| `observe.sources` | 要觀察哪些 AI 工具的對話（見下一節） | `["claude-code"]` |
| `port` | 連接埠 | 5188 |

示範模式（`npm run demo`）永遠使用內建的兩層樓示範設定，不受這個檔影響；想看自己的設定效果請用 `npm start`。

## 觀察來源（接其他 AI 工具）

目前內建一種觀察來源：`claude-code`，讀 `~/.claude/projects` 的對話紀錄。設定檔的 `observe.sources` 決定要啟動哪些來源；寫了不認得的名稱，主控台會印一行警告並略過，其他來源照常運作；寫成空陣列 `[]` 就什麼都不觀察。

想接其他工具（例如 Codex CLI）：

1. 在 `server/src/observe/` 寫一個轉接器，實作 `ObserveSource`（`id`、`start()`、`stop()`），自己負責找紀錄檔、只讀新增的內容，並把每一行轉成 `OfficeEvent` 交給狀態庫（可以參考 `transcriptWatcher.ts` 與 `transcriptParser.ts`）。
2. 在 `server/src/observe/sources.ts` 的 `SOURCE_FACTORIES` 用一個新的 id 註冊它。
3. 使用者在設定檔寫 `"observe": { "sources": ["claude-code", "<新的 id>"] }`。

畫面完全不用改：所有來源都只產出 `OfficeEvent`，畫面只收加工後的 `OfficeView`。

## 「等你核准」Hook（選裝，只限 Claude Code）

不裝也看得到「等你回答」（Claude 問你問題、等你看計畫時）。裝了 Hook 之後，**權限確認**（要你按允許的時候）也會顯示「等你核准」。

```bash
npm run hook:install            # 先看會寫入什麼，不會改任何檔案
npm run hook:install -- --yes   # 確認後才寫入 ~/.claude/settings.json
npm run hook:uninstall -- --yes # 移除
```

- 寫入前會先備份成 `settings.json.ai-office.bak`；你原本的其他設定與 Hook 都保留。
- 只會加一筆 Notification Hook，用命令裡的 `ai-office-hook` 辨識；移除時也只移除這一筆。
- Hook 腳本 1 秒內一定結束、不輸出任何東西、永遠回報成功：辦公室沒開時對任何 Claude Code 對話都沒有影響。
- 只對安裝後**新開**的 Claude Code 對話生效。

## 程式結構

```
server/src/
  office/    事件契約 OfficeEvent、狀態庫、加工站（樓層／職稱／中文／遮罩）、設定
             feed.ts＝名字、動態牆、交接弧線；outputPreview.ts＝產出預覽
  observe/   觀察來源：sources.ts＝註冊表；transcriptWatcher.ts＝Claude Code 轉接器；
             changeProgress.ts＝tasks.md 進度
  http/      本機伺服器：靜態檔、/api/state、/api/output/<代號>、/events（SSE）、/hook
  demo/      示範劇本（虛構資料）
  main.ts    npm start / npm run demo 的進入點
web/src/
  scene/     Three.js 等角場景、格子配置、A* 尋路、工位分配、閒置走動、日夜
  text.ts    畫面上所有固定文字（之後要加語言只換這裡）
  ui.ts      分頁、統計列、側欄
  cards.ts   底部員工卡片與產出預覽視窗
  arcs.ts    卡片之間的交接弧線
  feed.ts    動態牆
hook/        Notification Hook 腳本與安裝／移除
scripts/     check-public.mjs＝個資掃描
assets/kenney/  Kenney CC0 家具與迷你人物（附授權檔）
tests/       vitest 測試與固定紀錄
```

## 參與開發

- 送出變更前請跑 `npm test`、`npm run typecheck`、`npm run build`。
- `npm run check:public` 會掃描所有會被提交的文字檔：出現電子郵件地址（GitHub noreply 與 example.com 除外）就失敗。你也可以在家目錄建立 `.ai-office/public-blocklist.txt`，一行一個你不想出現在程式庫裡的字串（例如自己的資料夾名稱），掃描會一併檢查；這個檔案只放在你的電腦上，不要放進程式庫。`npm test` 也包含這項檢查。
- 這是個人專案，盡力維護；歡迎開 Issue 回報問題。

## 授權

- 程式：[MIT](LICENSE)
- `assets/kenney/` 的模型來自 Kenney（www.kenney.nl）的 Furniture Kit 與 Mini Characters，授權為 CC0（見同資料夾的兩份授權檔）。
