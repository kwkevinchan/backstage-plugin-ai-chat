# Backstage 外掛：AI 對話

> **非官方。** 這是社群外掛，與 Backstage 專案無隸屬、背書或支援關係。

在 [Backstage](https://backstage.io) 裡和語言模型對話。模型可以**以登入者的身分**呼叫
Backstage actions registry 裡的 action：

- 只讀取的 action（`readOnly: true`）立刻執行。
- **其他所有 action 都會停下來，等使用者在對話裡核准。** 核准卡片會顯示完整的輸入；
  按 **Allow** 只會執行那份輸入，按 **Deny** 就不執行。

對話本身不認識任何 action 來源。後端有註冊 action 的外掛都能用：catalog、
[Temporal 外掛](https://github.com/kwkevinchan/backstage-plugin-temporal)、自己寫的外掛。

迴圈寫在獨立的套件 [`@kwkevinchan/ai-chat-harness`](packages/ai-chat-harness)，不依賴
Backstage。後端外掛把它接上資料庫、actions service 和 HTTP。設計文件在
[docs/design](docs/design/README.zh-TW.md)；P1 每一條需求對到哪個測試，見
[p1-coverage.zh-TW.md](docs/design/p1-coverage.zh-TW.md)。

## 安裝

```sh
yarn --cwd packages/backend add @kwkevinchan/backstage-plugin-ai-chat-backend
yarn --cwd packages/app add @kwkevinchan/backstage-plugin-ai-chat
```

```ts
// packages/backend/src/index.ts
backend.add(import('@kwkevinchan/backstage-plugin-ai-chat-backend'));
```

前端（新前端系統）：`import aiChatPlugin from '@kwkevinchan/backstage-plugin-ai-chat/alpha'`，
頁面在 `/ai-chat`，每一段對話有自己的網址 `/ai-chat/<session id>`。
`/ai-chat?entityRef=component:default/my-service` 會以那個 entity 開啟對話。
舊前端系統的接法見[英文 README](README.md#frontend-legacy-frontend-system)。

後端用自己的資料庫存狀態（`sessions`、`runs`、`items` 三張表），啟動時自己跑 migration。SQLite 只允許一條連線（連線池的上限必須是 1，這是 Knex 對 SQLite 的預設，除非設定改過）。需要多條連線時用 PostgreSQL。

## 設定

```yaml
aiChat:
  llm:
    baseUrl: https://api.openai.com/v1 # 任何相容 OpenAI Chat Completions 的伺服器
    apiKey: ${AI_CHAT_API_KEY}
    model: gpt-4o-mini
    images: false # 模型能讀圖片；預設 false。圖片會送到模型伺服器，見下方說明
  toolsets: # 工具分組
    catalog:
      title: Catalog
      actions: ['catalog:*'] # * 代表任意字元
      exclude: ['catalog:unregister-*'] # 選用：不屬於這一組
      default: true # 新對話預設開啟；預設 false
    web:
      actions: ['web:*']
      egress: true # 會把資料送出組織：即使唯讀也要核准
  policy: # 用完整的 action ID：allow、ask 或 deny
    'catalog:get-entity': allow
    'temporal:terminate-workflow': deny
  agents: # 選用；沒有這一段時只有 default 這一個 Agent
    default:
      title: Backstage Agent
      toolsets: [catalog]
    sre:
      title: SRE Agent
      systemPrompt: 你協助 example.com 的值班工程師排查問題。動手前先寫計畫，回答附上來源。
      toolsets: [catalog]
      skills: [deploy-failure, rollback]
      model: default
      planning: required
      limits:
        maxSteps: 8
        maxToolCallsPerRun: 20
        runTimeoutSeconds: 300
  maxTurns: 10 # 一次 Run 的模型呼叫數；預設 10
  maxToolCallsPerRun: 30 # 一次 Run 的工具呼叫數；預設 30
  runTimeoutSeconds: 300 # 一次 Run 的工作時間（不含等核准）；預設 300，最大 600
  context:
    tokenBudget: 100000 # 送給模型的內容的 token 預算（估計值）；預設 100000
    keepRecentSteps: 6 # 最近幾步一律保留；預設 6
  maxToolOutputChars: 20000 # 工具輸出存下並送給模型的字元上限；預設 20000，最小 100
  input: # Run 進行中使用者可以加的訊息
    insert:
      maxPerRun: 5 # 一次 Run 最多插入幾則，最大 20；預設 5
    queue:
      maxMessages: 5 # 一段對話的佇列最多幾則；預設 5
    images: # 需要 llm.images: true
      maxPerMessage: 4 # 一則訊息最多幾張；預設 4
      maxBytes: 5242880 # 單張上限；預設 5 MB
      maxBytesPerInput: 20971520 # 一次 Run 和一次模型呼叫的圖片位元組上限；預設 20 MB，不小於 maxPerMessage 乘 maxBytes
      maxPendingPerSession: 12 # 上傳了但還沒進訊息的圖片；預設 12
      tokensPerImage: 1600 # 一張圖片在預算裡的估計 token；預設 1600
  retention:
    days: 90 # 最後一次變更超過這麼多天的對話會刪除；0 代表保留；預設 90
backend:
  actions:
    pluginSources: [catalog] # 對話只看得到這些外掛的 action
```

只有 `aiChat.llm` 是必填。啟動時會讀取並檢查整段設定，值不對會讓後端無法啟動。

**圖片。** `aiChat.llm.images: true` 時，使用者可以在訊息附上 PNG、JPEG、WebP 或 GIF。**圖片會隨訊息送到模型伺服器**；伺服器在組織之外時，圖片就離開組織。不允許時保持預設（關閉）。圖片存在後端的資料庫、屬於一段對話，只有擁有者讀得到；沒有進任何訊息的圖片 24 小時後刪除。

`input.images.tokensPerImage`（預設 1600）是一張圖片在上下文預算裡算幾個 token。
它是估計值，沒有對照實際模型量過。請管理員照自己的模型調整：估太低，送給模型的內容可能超過模型的上下文上限；估太高，舊圖片會太早被拿掉。

**保存期限。** 每小時會刪除最後一次變更超過 `aiChat.retention.days`（預設 90，一天是 24 小時）的對話，連同它的 Run、訊息、排隊的訊息和圖片。稽核紀錄會留下。還有 Run 沒結束的對話會留到那個 Run 結束。釘選或封存不會讓對話超過期限還留著；改名、釘選、封存、開關工具組，以及新的訊息，都算一次變更。`days` 設成 `0` 就全部保留。剛好滿 `days` 的對話會留下。

- **Toolset**：對話只看得到自己開啟的工具組裡的 action。不在任何一組裡的 action 不會出現。
  使用者在自己的對話裡開關工具組（對話欄最上面、訊息列表之上的 **Toolsets**），範圍不超過你定義的。
  沒設定 `toolsets` 時，所有 action 在同一組，預設開啟。
- **Policy**：`deny` 永遠不執行也不提供；`ask` 每次都問；`allow` 只對標了
  `readOnly: true` 而且不在 `egress` 工具組的 action 有效。沒標 `readOnly` 的
  action 當成不是唯讀，仍然要核准；只有 `policy` 把這種 action（或 `egress` 工具組裡的唯讀 action）設成
  `allow` 時，才會在 log 記一筆警告。
- **上限**：一次 Run 是一則使用者訊息加上之後的核准。步數、工具呼叫數、工作時間任何一個到上限
  就停下來。工作時間不含等核准的時間，而且 Run 會在使用者 token 過期之前結束。
- **上下文**：超過 `tokenBudget` 時，先把舊的工具輸出縮成一行；還是超過，就把舊的步驟換成模型寫的摘要，
  畫面會提示較早的內容被省略。紀錄本身不變。
- `actions.include`、`actions.exclude` 已淘汰：沒設定 `toolsets` 時它們組成預設的那一組，
  有設定時被忽略，啟動時會記警告。
- **Agent**：沒有 `aiChat.agents` 時只有 `default`（內建規則加上 `aiChat.systemPrompt`）。
  設定檔裡的 Agent，系統提示是內建規則再加上該 Agent 的 `systemPrompt`；沒寫就改用全站的
  `aiChat.systemPrompt`，兩段額外說明不疊加。`toolsets` 必須是已經定義的工具組。
  `skills`、`model`、`limits`、`planning: required` 會記在 Agent 上。迴圈仍用全站的上限和
  唯一的模型；這些欄位這一版還不執行。值不對會讓後端無法啟動。
- 別的 backend module 透過 `@kwkevinchan/backstage-plugin-ai-chat-node` 註冊 Agent，不必
  import 宿主。模組註冊的 Agent 也套同一套內建規則。設定檔和 module 用了同一個 id 時，後端無法啟動。
  這個庫的 `plugins/ai-chat-backend-module-example` 是可以照抄的範例（Agent id 是 `guide`），
  不是要安裝的套件。

細節見[英文 README](README.md#agents)。

## 核准的規則

- 核准時執行的是**後端存起來的輸入**；`decision` 路由不接受請求帶來的新輸入。執行前會用
  action 現在的 schema 和政策再檢查一次，變了就不執行。
- 一次決定只會被接受一次（資料庫的唯一索引），而且只有對話的擁有者能決定；別人得到 `404`。
- 不是唯讀的 action，沒有核准就絕不執行；唯讀與否看 actions service 的屬性，不看模型的說法。
- 一步裡有多個要核准的呼叫時，各自決定；全部決定後，核准的照順序執行。
- 等核准的 Run 會佔住那段對話：新訊息得到 `409`。按 **Stop** 會結束它，那些呼叫不會執行。
- 不是唯讀的 action 執行前先記「開始執行」。後端在執行中途停掉時不會重跑，畫面顯示「Result unknown」。
- 不是唯讀的 action 的核准、拒絕與執行會寫入 Backstage auditor
  （`tool-call-approve`、`tool-call-deny`、`tool-call-invoke`）；唯讀的 action 執行時不稽核。

## 多台 backend

Run 的狀態在資料庫，不在行程裡，所以可以部署多台，也可以重啟。

- 關掉分頁或斷線不會停止 Run。它會跑完並存檔，重新打開就看得到。
- 執行中的 Run 在資料庫持有租約，由那一台每 10 秒續約。等核准的 Run 沒有租約，所以收到最後一個決定的那一台
  （不一定是當初開 Run 的）接手繼續，工具只執行一次。
- 一台 backend 關機時，不再接新的 Run，最多給進行中的 Run 20 秒，沒跑完的標成 `expired`。它只動自己的 Run。
- 一台 backend 沒有關機就當掉時，租約過期（30 秒，每 30 秒檢查一次）後，別台把它的 Run 標成 `expired`，
  那段對話就可以送新訊息。畫面對 `expired` 的 Run 顯示「The last run stopped before it gave an answer.」和重送的按鈕。

## 已知限制

- 打開正在跑 Run 的對話時，只有跑那個 Run 的那一台能接回串流；別台的
  `GET /sessions/:id/stream` 回 `204`，畫面顯示目前存下的內容。
- 摘要涵蓋最新使用者訊息之前的步驟；同一個 Run 裡的舊步驟只縮短和省略，不做摘要。
- 對話列表在 P1 沒有自動標題，每一段都顯示 `New conversation`。

完整的安全說明、API 與試用方式見[英文 README](README.md)。

## 授權

[Apache License 2.0](LICENSE)。
