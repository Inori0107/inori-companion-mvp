# INORI Companion v1.3.1｜楪祈的房間

以《罪惡王冠》楪祈為核心的私人同人 AI 陪伴系統。角色設定分為 **CANON**、**INTERPRETATION** 與 **IF**。IF 世界線是「靜謐的岔路」。專案附抽象立繪與原創示例。原作資料以[《罪惡王冠》官方角色頁](https://guilty-crown.jp/character/)為起點。

## 本機啟動

需要 Node.js 22 與 npm。解壓縮後進入專案目錄。

```sh
npm ci
npm run dev
```

開啟 [本機房間](http://127.0.0.1:3000)。預設使用 Mock 與本機持久化資料，無需 API Key 或 Supabase 帳號。設定中的「人格校調後台」可執行合成題庫。原型的 `node server.mjs` 入口仍在，直接使用前請先執行 `npm run build`。

要啟用本機真實聊天，複製 `.env.example` 為 `.env`，在伺服器設定 `OPENAI_API_KEY`，選擇帳號可用的 `OPENAI_MODEL`，再啟動。純本機的真實 AI 只接受 loopback 請求。本機房間檔案預設放在 `.inori-data/`，可用 `INORI_DATA_DIR` 指定。伺服器以單一 Node 程序使用這個本機資料目錄。

## 自訂角色、立繪與分享

- 開啟房間上方的「自訂角色」，可選楪祈 IF 或原創角色，填入名稱、問候語、世界觀、個性和說話方式。表單最下方的「儲存角色」會一次提交角色文字及所有立繪增刪與規則。關閉時可捨棄草稿。僅更換立繪時沿用目前對話上下文。
- 立繪可逐張加入、預覽和設定。選「表情」可對應房間狀態，選「互動動作」可對應像是打招呼或一起唱歌。選「對話關鍵字」時，只比對最新一輪已完成的使用者訊息及角色回覆，命中多個時採用較長的關鍵字。未命中時回到對應表情，最後再使用「普通」立繪。
- 每個房間最多 14 張立繪。瀏覽器會轉成 PNG 或 JPG 並將單張壓至 100 KiB 內。PNG、JPG、WebP 可用，HEIC 取決於瀏覽器的圖片解碼支援。儲存後立繪跟隨房間資料，本機模式存在 Mac 資料目錄，雲端模式在同一帳號的裝置間同步。立繪由同一網域的登入 API 讀取。若縮圖已儲存但首頁顯示「目前無符合立繪」，可將一張表情設為「普通」。若載入失敗，房間或縮圖會顯示錯誤，包含取得的 HTTP 狀態。正式站若有草稿縮圖、儲存後卻無法載入，請確認新版已部署。新版使用單層 `/api/portrait?id=…`，而 `/api/health` 會回傳 `portraitDelivery: "session-json"`。
- 儲存角色文字後，名稱及問候語會套用到房間與已連線的新版 Widget。下一則對話會使用新的角色設定及有效記憶，舊聊天仍可回顧。Mock 顯示固定示範回覆，連接 OpenAI 後才會依個性與世界觀生成自由對話。
- 「設定 → 資料與分享」統一提供匯入檔案、匯出角色範本及匯出私人備份。角色範本只含文字設定，朋友匯入後會開啟草稿，可預覽、修改再儲存。私人備份包含立繪和房間紀錄，適用於還原空白房間。分享範本前可檢查文字欄位是否含私人資訊。
- 共用同一個部署時，管理者先在 Supabase 建立或邀請朋友的已確認帳號，將電子郵件加進 Vercel 的 `ALLOWED_EMAILS` 後重新部署。朋友用自己的帳號登入即可編輯自己的角色、聊天和記憶。一般使用者權限足以自訂角色；`ADMIN_EMAILS` 只用來管理共用楪祈版本和校調後台。若共用伺服器的 OpenAI 金鑰，生成用量會記在該 OpenAI 專案，應用內仍按帳號限制每日次數。
- 朋友也可用專案 ZIP 自行啟動或部署，搭配自己的環境變數、帳號和資料庫。本機 Mock 是單人房間，共用部署時請使用雲端登入。

從舊版升級時，更新原始碼後重新部署，或在本機重新啟動 `npm run dev`，再重新整理頁面。沿用同一個資料目錄、Supabase 專案與網站來源即可保留既有房間。舊版存於瀏覽器的立繪會出現在原裝置的角色編輯器，儲存一次即可移入房間資料。新增欄位向下相容原有 JSONB 文件，沿用原 migration。

## 功能與資料流

- **聊天**。OpenAI Responses API 串流、歷史時間、表情、最後一則重新生成、重試去重與自願評分。重新生成會替換原回覆並移除舊評分。取得完整串流後才提交對話。
- **記憶**。新增、編輯、刪除、重要性、來源與到期管理。核心、事件與短期記憶由使用者確認。以「請記住：內容」可建立當次候選。共同記憶可從有意義的已保存互動中選擇加入。聊天按中文雙字、詞、日期、類型與重要性取最多六筆。刪除、過期與內容更正會切換上下文版本並移除可能受影響的評分副本。既有聊天仍可在歷史回顧，模型從新上下文開始。
- **互動與日記**。打招呼、摸頭、牽手、擁抱、聽歌、唱歌、分享心情。選擇心情後會得到對應回應，事件保存前後五維狀態與反應。關係階段綜合信任、熟悉、舒適與經確認的共同經歷。日記可回看日期，區分固定示範、事件摘要和 AI 日記。AI 日記由模型從該日真實事件選擇代表事件與受限結語，再由伺服器驗證並組成文字。
- **校調**。管理者可複製和發佈角色版本，編輯 CANON、來源、IF、語氣規則與示範對話。可手動輸入五維狀態，比較兩個模型或版本。內附 50 題與兩個獨立的多輪情境，可批次執行並保存模型、版本、狀態、形式檢查與人工評分。私人聊天評分留在自己的房間資料。後台題庫與自訂情境使用合成資料。
- **手機**。沿用原型的深色介面，加入安全區域、PWA 安裝入口、可依表情、互動及關鍵字切換的立繪與 Scriptable。PWA 離線快取靜態介面。聊天、記憶與同步需要連線。
- **同步與備份**。雲端以同一帳號取回房間資料，前景每 15 秒與重新取得焦點時同步。房間顯示最近 180 則聊天，可從「設定 → 資料與分享」匯出完整紀錄。在空白房間可匯入聊天、有效的手動記憶、互動歷史、角色設定、基本設定及立繪。同來源的本機舊版瀏覽器可選「遷移原型資料」。其他來源可先匯出原型 JSON。匯入歷史保留為回顧，既有狀態、評分、AI 日記、共同記憶關聯與歷史上下文不重新啟用；歷史互動不參與新 AI 日記。清除房間會撤銷 Widget 憑證、清除房間紀錄及立繪，保留當日用量，Supabase 帳號仍可登入。

瀏覽器呼叫 Node API。伺服器確認身分後，從帳號房間載入近期訊息、有效記憶與角色狀態，組合版本化人格、個人角色素材和原創示例，再呼叫 Mock 或 OpenAI。雲端使用 Supabase Auth 和 PostgreSQL。資料以每個帳號一份 JSONB 文件保存，校調版本與合成評測另存。版本欄位讓多個 Vercel 執行個體以條件更新避免覆寫。RLS 與權限限制直接存取，後端根據已驗證的 Auth 使用者 ID 決定房間。Widget 憑證是可撤銷的隨機唯讀 Bearer token，資料庫只保存雜湊值。

| 路徑 | 用途 |
| --- | --- |
| `public/` | 手機房間、校調介面、PWA |
| `src/character.ts`、`src/design.ts`、`src/provider.ts` | 人格、原創示例、Prompt、Mock 與串流 Provider |
| `src/domain.ts`、`src/service.ts`、`src/portraits.ts` | 狀態、互動、記憶、對話、日記與立繪 |
| `src/evaluations.ts` | 50 題、保留多輪情境、評分權重 |
| `src/auth.ts`、`src/storage.ts`、`src/http.ts` | 驗證、資料儲存、請求邊界 |
| `supabase/migrations/`、`vercel.json`、`api/` | migration 與部署入口 |
| `scriptable/InoriWidget.js`、`tests/` | iPhone Widget 腳本與測試 |

## Supabase 與 Vercel 部署

1. 建立 Supabase 專案，在 SQL Editor 執行 `supabase/migrations/202611090001_inori_documents.sql`，或透過 Supabase CLI 對已連結專案執行 migration。確認 Data API 開啟。建立電子郵件已確認的私人帳號，使用 Email/Password 登入並關閉公開註冊。[Supabase 密碼登入文件](https://supabase.com/docs/guides/auth/passwords)
2. 將本專案放入自己的版本庫，Vercel 匯入此目錄作為專案根目錄，使用 Node.js 22 與預設的 `vercel.json`。Vercel 部署的 `APP_ORIGIN` 應填實際開啟的單一 HTTPS origin，包含協定與網域。Production 與 Preview 若都使用，請分別指定相符網域，並使用適合該環境的資料庫。[Vercel Node.js runtime 文件](https://vercel.com/docs/functions/runtimes/node-js)
3. 填妥以下伺服器環境變數後部署。登入測試兩個不同帳號及同帳號兩部裝置，確認互相隔離與同步。啟用 OpenAI 時，先用少量對話與合成題確認模型、串流、費用與回覆品質。

| 變數 | 說明 |
| --- | --- |
| `SUPABASE_URL` | Supabase 專案 URL |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key |
| `SUPABASE_SECRET_KEY` | Supabase secret key，僅伺服器 |
| `APP_ORIGIN` | 使用的 HTTPS 網站，例如 `https://your-inori-project.vercel.app` |
| `ALLOWED_EMAILS` | 允許登入的已確認電子郵件，以逗號分隔 |
| `ADMIN_EMAILS` | 允許登入清單中擁有校調權限的電子郵件 |
| `OPENAI_API_KEY` | 可選。留空時整個服務使用 Mock |
| `OPENAI_MODEL` | 可選，預設 `gpt-4.1-mini` |
| `ADMIN_MODELS` | 可選，校調允許額外測試的模型，以逗號分隔 |
| `MAX_AI_PER_DAY` | 每帳號每日生成上限，預設 60，範圍 1–200；UTC 午夜重設 |
| `HOST`、`PORT`、`INORI_DATA_DIR` | 選填的本機開發設定 |

使用既有 Supabase 專案時，也可透過 `SUPABASE_ANON_KEY` 與 `SUPABASE_SERVICE_ROLE_KEY` 設定舊版 JWT。[Supabase API Key 文件](https://supabase.com/docs/guides/getting-started/api-keys)

聊天、重生、日記與評測共用生成配額，同一帳號一次只能有一個生成，已送出的生成嘗試會計入配額。完整套件需要 52 筆配額。各請求有輸入、上下文、輸出 token 與逾時限制。正式部署可使用 OpenAI 專案專用 Key 並查看專案用量。清除房間的刪除作用於目前應用資料庫，服務供應商依各自設定管理歷史備份。

## iPhone 與 Scriptable

- Safari 開啟部署後的 HTTPS 網址，在分享選單選「加入主畫面」。
- 用 iPhone 開啟正式網站，從「設定 → 主畫面小工具」勾選「在小工具顯示立繪與最近互動」，再產生專用 `WIDGET_TOKEN`。舊憑證仍只會提供問候、角色名稱等摘要。重新產生會讓上一個憑證失效。
- 安裝 Scriptable，貼入新版 `scriptable/InoriWidget.js`，填入正式 HTTPS `CHAT_URL` 和 `WIDGET_TOKEN`。可設定備用的 `MEET_DATE` 與 `CHARACTER_NAME`。先在 Scriptable 按執行看中尺寸預覽，再於主畫面加入中尺寸 Widget 並選取這份腳本。
- 連線後顯示房間立繪與最近互動的名稱。點「互動」會開啟房間的互動分頁，互動在房間內完成。連線出錯時會顯示原因和本機備用台詞；可選擇在 Scriptable 本機文件目錄放入自己的 `inori.png`。iOS 決定主畫面更新時機。

## 驗證與後續

```sh
npm run typecheck
npm test
npm run build

# 首次設定 Chromium，或改用 CHROMIUM_PATH 指定本機 Chrome。
npx playwright-core install chromium
npm run test:browser
```

v1.3.1 已執行 TypeScript 型別檢查、production build、15 項單元與整合測試，以及 Playwright 行動尺寸 Chromium 流程。涵蓋立繪授權與重試、Widget 憑證範圍、Scriptable 腳本模擬、互動入口與既有備份還原。資料庫 schema 沿用 v1.0 已在本機 PostgreSQL 17 驗證的 migration。專案未配置 lint。題庫的 Mock 執行及形式檢查用來驗證測試路徑；規格的人格、語氣、原作與記憶品質目標需以實際模型結果和人工評分驗收。

此交付尚待實際 OpenAI、Supabase、Vercel 部署和 iPhone Safari／Scriptable 實機驗收。下一步是在受控雲端環境完成同帳號跨裝置流程、Widget 撤銷與記憶刪除驗收，然後以實際選定模型執行 50 題與保留多輪案例並人工評分。
