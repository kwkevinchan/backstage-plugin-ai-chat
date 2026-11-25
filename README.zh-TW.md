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
[docs/design](docs/design/README.zh-TW.md)；P1 每一條需求對到哪個測試見
[p1-coverage.zh-TW.md](docs/design/p1-coverage.zh-TW.md)，PI 見
[pi-coverage.zh-TW.md](docs/design/pi-coverage.zh-TW.md)。

## 安裝

```sh
yarn --cwd packages/backend add @kwkevinchan/backstage-plugin-ai-chat-backend
yarn --cwd packages/app add @kwkevinchan/backstage-plugin-ai-chat
```

```ts
// packages/backend/src/index.ts
backend.add(import('@kwkevinchan/backstage-plugin-ai-chat-backend'));
```

`GET /sessions` 在 Run 尚未結束時會帶 `activity`（`running` 或
`waiting_approval`）。要將活動變化（`running`、`waiting_approval`、
`replied`、`idle`）推送到擁有者的 `ai-chat` Signals 頻道，依這個 Backstage
版本的方式安裝 `@backstage/plugin-signals-backend` 並加上這個 module：

```ts
import { aiChatSignalsModule } from '@kwkevinchan/backstage-plugin-ai-chat-backend';

backend.add(import('@kwkevinchan/backstage-plugin-ai-chat-backend'));
backend.add(aiChatSignalsModule);
backend.add(import('@backstage/plugin-signals-backend'));
```

前端（新前端系統）：`import aiChatPlugin from '@kwkevinchan/backstage-plugin-ai-chat/alpha'`，
頁面在 `/ai-chat`，每一段對話有自己的網址 `/ai-chat/<session id>`。
`/ai-chat?entityRef=component:default/my-service` 會以那個 entity 開啟對話。
別的 frontend plugin 用 `@kwkevinchan/backstage-plugin-ai-chat-react` 的
`<AiChatLauncher prompt="…" entityRef="…" />`、`useAiChatPanel()` 或
`aiChatPanelApiRef` Utility API 開啟側邊面板，並帶入 prompt 和 entity（app
沒裝 chat 外掛時按鈕不顯示）。`prompt` 會以登入者的身分立刻送出，請使用固定字串
或程式可控的內容，不要從網址參數或不受信任的輸入組合；只有 entity 時，下一則從面板
送出的訊息帶著它。面板等登入完成後才出現，掛在路由外面，換頁不會卸下進行中的對話。
舊前端系統要在 router 裡、路由外面掛一次 `<AiChatPanel>`；新前端系統註冊 plugin 就有這塊面板。
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
  maxToolOutputChars: 20000 # 工具輸出（含 load_skill 回傳的 Skill 全文）存下並送給模型的字元上限；預設 20000，最小 100
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
  sharing: # 啟動時讀取；這一版還不能建立或修改分享
    live:
      enabled: true # 分享能不能持續更新；預設 true
      defaultHours: 24 # 沒指定時，持續更新的分享維持幾小時；預設 24
      maxHours: 72 # 最長幾小時；預設 72
  retention:
    days: 90 # 最後一次變更超過這麼多天的對話會刪除；0 代表保留；預設 90
backend:
  actions:
    pluginSources: [catalog] # 對話只看得到這些外掛的 action
```

只有 `aiChat.llm` 是必填。啟動時會讀取並檢查整段設定，值不對會讓後端無法啟動。

**分享的上限。** `aiChat.sharing.live` 在啟動時讀取。`enabled`（預設 true）是分享能不能持續更新。`defaultHours`（預設 24）是沒有指定時，持續更新的分享維持幾小時；`maxHours`（預設 72）是最長的時數。沒寫 `sharing` 或 `live` 就用這些預設。`enabled: false` 會存成 false。兩個小時數都必須是正整數，而且 `defaultHours` 不能大於 `maxHours`，否則後端無法啟動。這一版還不能建立或修改分享，所以這些值只會被檢查並留下。

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
  Agent 的 `skills` 已經生效：決定這個 Agent 能用哪些已註冊的 Skill（沒填就是全部，`[]` 就是沒有），
  填了不存在的 Skill id 時後端無法啟動。`toolsets`、`model`、`limits`、`planning: required` 只記在
  Agent 上，這一版還不執行：迴圈仍用全站的上限和唯一的模型，不依 Agent 的 `toolsets` 過濾工具，也不要求先寫計畫。
  `aiChat.skills.directories` 可載入子目錄內的 `SKILL.md`（上下文只含 id 與一句說明，由唯讀內建工具 `load_skill` 延遲載入全文；相對路徑以後端的工作目錄為基準；符號連結會跟過去，但子目錄或 `SKILL.md` 解析後在設定的目錄外面時，後端無法啟動）。值不對會讓後端無法啟動。
- 別的 backend module 透過 `@kwkevinchan/backstage-plugin-ai-chat-node` 註冊 Agent、Hook 與 Skill（`addAgent`、`addHook`、`addSkill`），不必
  import 宿主。模組註冊的 Agent 也套同一套內建規則。設定檔和 module 用了同一個 id 時，後端無法啟動。
  `addHook` 支援 `beforeModelCall`、`beforeToolCall`、`afterToolCall` 與 `onRunEnd`。`beforeToolCall` 只能調嚴（`ask`／`deny`），不能放寬。
  Hook 丟例外時：`beforeModelCall` 讓 Run 失敗；`beforeToolCall` 讓這個工具呼叫被拒絕，Run 繼續；
  `afterToolCall` 讓這個工具結果變成錯誤，不保留原始輸出，Run 繼續；`onRunEnd` 只記 log，不影響 Run。
  這個庫的 `plugins/ai-chat-backend-module-example` 是可以照抄的範例（Agent id 是 `guide`、Skill id 是 `getting-started`），
  不是要安裝的套件。

細節見[英文 README](README.md#agents)。

## TechDocs 搜尋

對話用 Backstage search backend（`@backstage/plugin-search-backend`）的 `search:query` 搜尋 TechDocs。這個外掛沒有自己的搜尋 action。
安裝 search backend 和它的 TechDocs collator（`@backstage/plugin-search-backend-module-techdocs`），把 `search` 加進既有的
`backend.actions.pluginSources` 清單（這個設定會取代整個清單），再把 action 放進一個工具組：

```yaml
backend:
  actions:
    pluginSources: [catalog, search] # 你原本的清單，再加上 search
permission:
  enabled: true # 沒有開時，search backend 不依權限過濾
aiChat:
  toolsets:
    docs:
      title: Docs
      actions: ['search:query']
      default: true
  agents:
    docs:
      title: Docs
      systemPrompt: >-
        Answer from TechDocs. Search with the type techdocs and a pageLimit of
        5. The location of a result is a path under https://backstage.example.com;
        cite every result you use as a full link, for example
        https://backstage.example.com/docs/default/component/payments/deploy/.
```

- action 用送出訊息的使用者的身分執行。只有 `permission.enabled` 是 `true` 時，search backend 才拿掉這個使用者不能讀的文件。
  TechDocs 的文件要有它所屬 entity 的 `catalog.entity.read`。沒有開 permission 時，每個人都搜得到全部的文件。
- `permission.enabled: true` 會讓整個 Backstage 進入權限模式，不只是搜尋：每個外掛都會向 permission backend
  （`@backstage/plugin-permission-backend`）要決定。要裝這個 backend，並且有會判斷 `catalog.entity.read` 的政策。
- `search:query` 是唯讀的，`policy` 沒有另外設定時直接執行，不用核准。模型看到的名稱是 `search_query`（工具名稱不能有 `:`）。
- 每一筆結果的文字是一頁裡一段的全文；對話從搜尋結果讀文件。TechDocs backend 的 `techdocs:get-techdocs-metadata`
  回傳網站的目錄，不回傳內容。要提供它，把 `techdocs` 加進 `backend.actions.pluginSources`，再把它放進一個工具組。
- 每一筆結果有 `document.title` 和 `document.location`。`location` 是路徑（`/docs/...`），對話只把 `http`、`https`、
  `mailto` 的網址做成連結，所以上面的系統提示請模型寫成完整的網址。`search.collators.techdocs.locationTemplate` 保留預設：
  它套用在整個搜尋索引，TechDocs 閱讀頁的搜尋框會把 `location` 當成 app 裡的路徑去換頁。
- 這個 action 的 input schema 有遞迴的 `$ref`（在 `filters`）。不接受工具 schema 裡有 `$ref` 的模型伺服器會拒絕請求。
- 搜尋失敗時，模型收到 `Request failed with <狀態碼> <狀態文字>`，不含搜尋引擎的錯誤內容。搜尋不回應時，Run 到 `runTimeoutSeconds` 結束。
- 輸出算在 `maxToolOutputChars` 裡。action 預設回傳 10 筆（`pageLimit`）；輸出被裁掉時，最後幾筆結果和它們的連結會不見，所以像上面一樣請模型少拿幾筆。

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

- 正在跑的 Run 在任何一台都能接回。跑那個迴圈的一台先送已經寫下的文字，再送同一則的後續內容；
  同一個 Run 之後若還有下一則回覆，在接回串流上會等它完成後整段送出。別台大約每秒送一個已完成的
  Item（整段，沒有逐字片段，輪詢項目之間沒有 step 邊界），Run 離開 `running` 時結束串流
  （`failed` 和 `expired` 一律回 `"The run stopped."`）。等核准、已結束、或沒有 Run 時，
  `GET /sessions/:id/stream` 仍回 `204`。
- 摘要涵蓋最新使用者訊息之前的步驟；同一個 Run 裡的舊步驟只縮短和省略，不做摘要。
- 對話可以依標題搜尋，也可以釘選、改名、封存。第一輪正常結束後會自動產生短標題；你自己改過的標題會留下。產生不出標題時，對話照常結束。

完整的安全說明、API 與試用方式見[英文 README](README.md)。

## 授權

[Apache License 2.0](LICENSE)。
