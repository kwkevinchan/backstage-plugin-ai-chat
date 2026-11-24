# 協定驗證（P1-01）

| 欄位 | 內容                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 狀態 | 已驗證                                                                                                                       |
| 日期 | 2026-11-24                                                                                                                   |
| 對應 | 實作規劃 P1-01、V-01；規格 D-05、D-19、A-03、A-07；程式架構第 8、9 節                                                        |
| 鎖定 | `ai@7.0.166`（2026-11-09 發佈）、`@ai-sdk/react@4.0.170`（2026-11-09）、`zod@4.1.12`（`ai` 的 peer：`^3.25.76 \|\| ^4.1.8`） |

## 1. 結論

- **對照表的事件名稱大致正確，有三處要改。** 核准用原生的 `tool-approval-request`，不用 `data-approval-request`。被拒絕的結果用 `tool-output-denied`。失敗和取消用 `error` 和 `abort`。
- **「停在核准上，之後由另一個請求繼續」協定有原生的表示法。** 用 `tool-approval-request` 和 `tool-approval-response`。協定不要求核准走哪個 URL，所以我們的 `POST .../decision` 照舊。`approvalId` 用 `toolCallId`，任何一台 backend 都能從紀錄查到。
- **前端用 `@ai-sdk/react` 的 `useChat`，加我們自己的 `ChatTransport`。** 載入已存的訊息、核准後在同一則訊息接續、重新整理後接回串流，三件事都實測過。接回串流要改 A-07 的做法：從目前 Run 的第一個 Item 重送，不是只送缺的。
- **在 Backstage CLI 的 jest 裡 import 得起來。** 探針通過（5.3 節）：`ai` 和 `@ai-sdk/react` 不需要改 jest 設定，`useChat` 在 jsdom 裡能處理串流。

## 2. 怎麼驗證的

版本的原始碼就在 npm 套件裡（`ai/src/`、`ai/docs/`、`@ai-sdk/react/src/`）。事件的型別和 zod schema 以這份為準。

文件：

- [Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)（套件裡是 `ai/docs/04-ai-sdk-ui/50-stream-protocol.mdx`）
- [Chatbot Tool Usage：Tool Execution Approval](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)
- [Transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport)
- [Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)

原始碼：

- `ai/src/ui-message-stream/ui-message-chunks.ts`：所有事件的 zod schema 和型別。
- `ai/src/ui-message-stream/ui-message-stream-headers.ts`：SSE 的 header。
- `ai/src/ui/process-ui-message-stream.ts`：事件怎麼變成訊息的 part。
- `ai/src/ui/chat-transport.ts`：`ChatTransport` 介面。
- `ai/src/ui/chat.ts`：`useChat` 底層的 `Chat`。

程式：三支用完即丟的小程式，不提交。環境：

```sh
mkdir p101 && cd p101 && npm init -y
npm i --save-exact ai@7.0.166 @ai-sdk/react@4.0.170 zod@4.1.12 \
  react@18.3.1 react-dom@18.3.1 jsdom@27.1.0 @testing-library/react@14.3.1
```

| 程式                | 做什麼                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.mjs`        | Node HTTP 伺服器。用 `createUIMessageStreamResponse` 照對照表送出 Run 的事件，以及核准後的接續事件。                                        |
| `check-parse.mjs`   | 用 `ai` 的 `parseJsonEventStream` 加 `uiMessageChunkSchema` 讀回每個事件，再用 `readUIMessageStream` 合成訊息。另外驗證錯誤的事件會被拒絕。 |
| `check-usechat.mjs` | 在 jsdom 裡用 `renderHook` 跑 `useChat`，接自己寫的 `ChatTransport` 和一個假的 backend。                                                    |

跑法：`node check-parse.mjs`、`node check-usechat.mjs`。Node 24。

## 3. 事件對照（第 1 點）

### 3.1 結果

20 個事件全部通過 `uiMessageChunkSchema`：

```
POST /runs -> 200
  content-type: text/event-stream
  cache-control: no-cache
  x-vercel-ai-ui-message-stream: v1
  x-accel-buffering: no
chunks validated by uiMessageChunkSchema: 20 / 20 failures: []
```

合成的訊息：

```
message after run 1: msg_1 [
  'step-start',
  'text:"Let me check."',
  'tool-catalog_get[call_1]:output-available output={"ok":true}',
  'step-start',
  'tool-deploy_app[call_2]:approval-requested approval={"id":"call_2","requestReason":"not read-only"}'
]
```

型別不對的事件會被擋下，所以拼錯名稱時，前端會直接報錯，不會默默忽略：

```
true   tool-output-error
true   data-plan
false  tool-approval-requested        （拼錯）
false  tool-approval-request 少 approvalId
false  type 沒有 data- 前綴的自訂事件
false  text-delta 少 id
```

### 3.2 要注意的欄位

| 項目       | 實測的結果                                                                                                                                                                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE 格式   | 每個事件一行 `data: <JSON>`，空行分隔。結尾送 `data: [DONE]`。                                                                                                                                                                                                                                                                           |
| Header     | `content-type: text/event-stream`、`cache-control: no-cache`、`x-vercel-ai-ui-message-stream: v1`、`x-accel-buffering: no`。SDK 還加 `connection: keep-alive`。HTTP/2 不允許這個 header，所以我們的 presenter 不送它。                                                                                                                   |
| `start`    | `messageId` 決定事件寫進哪一則訊息。同一個 messageId 的後續串流，接在同一則訊息上。                                                                                                                                                                                                                                                      |
| 自訂資料   | 型別是 `data-<名稱>`，欄位 `data`，可選 `id` 和 `transient`。有 `id` 的事件，後送的取代先送的（`data-plan` 用這個）。`transient: true` 的事件不進訊息，只給 `onData`。                                                                                                                                                                   |
| 工具呼叫   | 可以只送 `tool-input-available`，不必先送 `tool-input-start`。                                                                                                                                                                                                                                                                           |
| 核准的欄位 | `tool-approval-request`：必填 `approvalId`、`toolCallId`；可選 `reason`、`approvalDescriptor`、`isAutomatic`、`signature`。                                                                                                                                                                                                              |
| 錯誤和取消 | `error`（`errorText`）：`useChat` 進入 `error` 狀態並呼叫 `onError`。`abort`（可選 `reason`）：回到 `ready`，不算錯誤；`useChat` 對它不做任何事，`onFinish` 的 `isAbort` 是 `false`。所以取消只能從 `data-run` 的狀態判斷。`error` 一出現，`useChat` 就丟例外，後面的事件收不到，所以要在 `error` 之前送 `data-run`，而且不送 `finish`。 |

`useChat` 對三種結尾的反應：

```
error then finish    status= error  onError= [ 'model failed' ]
abort                status= ready  onError= []
ends without finish  status= ready  onError= []
```

### 3.3 更新後的對照表

這張表已經寫進程式架構第 8 節。

| HarnessEvent                                                    | UI message stream                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.started`                                                   | `start`（`messageId` 用 Run 的 id 推出來），加 `data-run`（`transient`，Run 的 id 和狀態）                                                                                                                                                                                                                                                                                                                                                                                              |
| `step.started`、`step.ended`                                    | `start-step`、`finish-step`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `item.started`（agent_message）、`item.delta`、`item.completed` | `text-start`、`text-delta`、`text-end`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `item.completed`（tool_call）                                   | `tool-input-available`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `run.ended`（等核准）的 `pending`，每個呼叫                     | 各送一次 `tool-approval-request`（`approvalId` 等於 `toolCallId`，`reason` 說明為什麼要核准）。從紀錄還原畫面時，「要核准」是 `needsApproval`、沒有 `approval`、沒有結果，而且 Run 是 `waiting_approval`、呼叫在它的最後一步，不看 `policy`。已決定但沒有結果的呼叫顯示成 `approval-responded`（5.5），只在 Run 是 `waiting_approval` 或 `running` 時。Run 已結束（`completed`、`cancelled`、`expired`）：沒有結果的呼叫看有沒有 `tool_started`，有顯示「結果不明」，沒有顯示成沒有執行 |
| `approval` Item（核准或拒絕）                                   | `tool-approval-response`（`approved`、可選 `reason`）。放在核准後接續串流的開頭                                                                                                                                                                                                                                                                                                                                                                                                         |
| `item.completed`（tool_result，成功）                           | `tool-output-available`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `item.completed`（tool_result，失敗）                           | `tool-output-error`（`errorText`）                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `item.completed`（tool_result，被拒絕）                         | `tool-output-denied`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `item.completed`（plan_update）                                 | `data-plan`（固定 `id`，同一則訊息內後送的取代先送的）                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 每一筆完成的 Item                                               | `data-item`（`transient`，`seq` 和 `kind`），給 A-07 接回用                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `run.ended`（等核准）                                           | `data-run`（`transient`，狀態），然後 `finish`（`finishReason: 'tool-calls'`）                                                                                                                                                                                                                                                                                                                                                                                                          |
| `run.ended`（完成）                                             | `data-run`（`transient`），然後 `finish`（`finishReason: 'stop'`）                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `run.ended`（失敗）                                             | `data-run`（`transient`），然後 `error`（`errorText`）。不送 `finish`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `run.ended`（取消）                                             | `data-run`（`transient`），然後 `abort`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

和原本的差別：

1. `data-approval-request` 改成原生的 `tool-approval-request`。
2. 新增 `tool-approval-response` 和 `tool-output-denied` 兩列。原本沒有「拒絕」那一列。
3. 新增失敗和取消的表示法。失敗的順序是 `data-run` 在前、`error` 在後：實測 `error` 之後的 `data-run` 和 `finish` 收不到（見 3.4）。
4. `data-run`、`data-item` 都標 `transient: true`。不標的話，它們會變成訊息的 part，每個 Item 多一個。

### 3.4 失敗的順序，和缺少開頭的文字事件

實測（`check-fixes.mjs`，`useChat` 加假的 transport）：

```
error, data-run, finish (舊)     status= error onData= []                  onError= [ 'model failed' ]
data-run, error (新)             status= error onData= [ 'data-run:failed' ] onError= [ 'model failed' ]
```

舊的順序收不到 `data-run`，畫面不知道 Run 的狀態。新的順序收得到。

`text-delta` 沒有先送 `text-start` 時，`useChat` 進入 `error`：

```
Received text-delta for missing text part with ID "t". Ensure a "text-start" chunk is sent before any "text-delta" chunks.
```

所以接回串流重送時，還沒完成的 Item 不能只轉送缺開頭的 `text-delta`。要補送 `text-start` 加已累積的文字，或等它完成再整段送。Run 在別台 backend 時拿不到逐字片段，只能等它完成再整段送。實測補送 `text-start` 加累積文字，後面的 `text-delta` 接得上：

```
[ 'step-start', 'text:"Let me check."', 'text:"Partial so far, and the rest."' ]
```

## 4. 等核准（第 2 點）

### 4.1 結論

協定有原生的核准事件，用它。不要自己用 `data-*` 做一套。

「核准」不是我聽說的 `needsApproval` 這個事件。`needsApproval` 是伺服器端工具的設定，在這個版本已標為過時，換成 `streamText` 的 `toolApproval`。串流上的事件是 `tool-approval-request` 和 `tool-approval-response`。我們不用 `streamText`，所以只用串流上的事件。

### 4.2 流程

```
請求 1  POST /sessions/:id/runs
        ... tool-input-available(call_2)
            tool-approval-request(approvalId=call_2, toolCallId=call_2)
            finish(finishReason=tool-calls)
        → 訊息裡的工具 part 是 approval-requested。串流結束，Run 停下來。

請求 2  POST /sessions/:id/tool-calls/call_2/decision   （可能打到另一台 backend）
        ... start(messageId 同上)
            tool-approval-response(approvalId=call_2, approved=true)
            tool-output-available(call_2)   或   tool-output-denied(call_2)
            text-start ... text-end
            finish(finishReason=stop)
        → 接在同一則訊息上。
```

實測：兩個串流合成同一則訊息，工具 part 從 `approval-requested` 走到 `output-available` 或 `output-denied`：

```
message after decision approved=true: msg_1 [
  'step-start',
  'text:"Let me check."',
  'tool-catalog_get[call_1]:output-available output={"ok":true}',
  'step-start',
  'tool-deploy_app[call_2]:output-available approval={"id":"call_2","requestReason":"not read-only","approved":true} output={"deployed":true}',
  'step-start',
  'text:"Done."'
]
message after decision approved=false: msg_1 [
  ...
  'tool-deploy_app[call_2]:output-denied approval={"id":"call_2","requestReason":"not read-only","approved":false}',
  'step-start',
  'text:"Done."'
]
```

### 4.3 兩個要決定的地方

- **`approvalId` 用 `toolCallId`。** 一個工具呼叫只會有一次核准，所以不需要另一個 id。D-18 要求任何一台 backend 都能接手。決定請求帶 `callId`，backend 讀紀錄就知道是哪個呼叫、有沒有已經決定過，不需要記憶體裡的狀態。
- **不用 `signature`。** `signature` 是給「用戶端每次送完整訊息歷史」的做法用的。伺服器要確認歷史沒被改過。我們的歷史在伺服器的紀錄裡，用戶端只送「這則訊息」或「這個決定」。核准的真偽由決定請求自己的身分檢查（D-05：新的請求，帶新的身分）。

## 5. 前端：`useChat` 還是自己寫（第 3 點）

### 5.1 結論

用 `useChat`，加自己寫的 `ChatTransport`。理由是下面四項都實測成功。自己寫的話，這四項的狀態機都要自己做。

在 Backstage CLI 的 jest 裡可以 import，也能處理串流（5.3 節）。

### 5.2 實測

測試用 `renderHook(useChat)`，接一個自己寫的 `ChatTransport` 和假 backend（`check-usechat.mjs`）。

**A. 載入已存的訊息，再送新訊息。** `useChat({ messages })` 帶入從 `GET /sessions/:id` 轉出來的訊息。transport 只送最後一則使用者文字，不送整段歷史：

```
initial: [ 'user:u_0', 'assistant:run_0' ]
  user u_0 [ 'text:"earlier"' ]
  assistant run_0 [ 'step-start', 'text:"Earlier answer."' ]
  user r5Lye0kXnIq4yv5O [ 'text:"deploy it"' ]
  assistant msg_1 [ 'step-start', 'text:"Let me check."', 'tool-catalog_get:output-available',
                    'step-start', 'tool-deploy_app:approval-requested' ]
onData data-item seqs: [ 3, 4, 5, 6 ]
POST /sessions/s1/runs {"text":"deploy it"}
```

**B. 核准走另一個請求，接在同一則訊息上。** `addToolApprovalResponse` 加 `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`。transport 在 `sendMessages` 裡看到最後一則助理訊息有 `approval-responded` 的 part，就打 `decision` 端點：

```
  assistant msg_1 [ ..., 'tool-deploy_app:output-available', 'step-start', 'text:"Done."' ]
POST /sessions/s1/runs {"text":"deploy it"}
POST /sessions/s1/tool-calls/call_2/decision {"approved":true}
```

**C. 重新整理，Run 還在跑，接回串流。** 這一項揭露了 A-07 的問題。

只送「缺的 Item」（A-07 原本的做法）：已存的 `Let me check.` 被蓋掉：

```
  assistant msg_1 [ 'step-start', 'text:"Resumed text."' ]
GET /sessions/s1/stream?afterSeq=3
```

原因：`useChat` 接回串流時，用新的狀態從頭開始合成，同 id 的訊息整則被取代（`ai/src/ui/chat.ts` 的 `makeRequestImpl`，`resume-stream` 分支只在有未完成的工具 part 時才帶入舊訊息）。

transport 設 `resumeStreamIsReplay = true`，伺服器從目前 Run 的第一個 Item 重送：

```
  assistant msg_1 [ 'step-start', 'text:"Let me check."', 'text:"Resumed text."' ]
GET /sessions/s1/stream?afterSeq=4&mode=replay
```

**D. 重新整理，Run 停在核准上。** 已存的訊息裡，工具 part 是 `approval-requested`。`reconnectToStream` 回傳 `null`（沒有進行中的串流），`useChat` 回到 `ready`，核准卡片還在。按下拒絕，照 B 的路徑打 `decision`：

```
status after empty reconnect: ready [ ..., 'tool-deploy_app:approval-requested' ]
[ 'step-start', 'text:"Let me check."', 'tool-deploy_app:output-denied', 'step-start', 'text:"Done."' ]
GET  /sessions/s1/stream?afterSeq=4&mode=none
POST /sessions/s1/tool-calls/call_2/decision {"approved":false}
```

`mode=replay` 和 `mode=none` 只是測試用的參數，用來讓假伺服器選回應。正式的端點定義在程式架構第 8 節。

### 5.3 在 Backstage CLI 的 jest 裡 import

結論：可以，不需要改 jest 設定。

為什麼預期可以：

- `ai`、`@ai-sdk/react` 等五個套件都是 `"type": "module"`，但 `exports` 有 `default` 條件，jest 找得到檔案。這點和 `react-markdown` 不同。
- 前端套件的 jest 設定（`jest.js` 的 `transformIgnorePatterns`）只排除固定幾個套件，沒有 `ai`。所以 `ai` 被 swc 轉成 CommonJS。
- 這五個檔案裡沒有 `import.meta`、動態 `import()`、頂層 `await`。

實測：在 repo 的 `plugins/ai-chat` 加 `ai@7.0.166` 和 `@ai-sdk/react@4.0.170`（`yarn add -E`），放兩個探針測試，跑 `CI=true yarn test --maxWorkers=2 protocolProbe`。測完刪掉探針，還原 `package.json` 和 `yarn.lock`，不提交。

探針 1：import 加 `renderHook(useChat)`。

```tsx
import { renderHook } from '@testing-library/react';
import { useChat } from '@ai-sdk/react';
import { uiMessageChunkSchema, parseJsonEventStream } from 'ai';

it('imports ai and useChat', () => {
  const { result } = renderHook(() => useChat({ id: 'x', messages: [] }));
  expect(result.current.messages).toEqual([]);
  expect(typeof parseJsonEventStream).toBe('function');
  expect(uiMessageChunkSchema).toBeDefined();
});
```

探針 2：在 jsdom 裡用 `ReadableStream` 送一段 SSE 文字，經 `parseJsonEventStream` 和自訂 transport，由 `useChat` 的 `sendMessage` 讀回。斷言最後一則助理訊息的文字是 `hi`。

輸出：

```
PASS src/protocolProbe2.test.tsx
PASS src/protocolProbe.test.tsx

Test Suites: 2 passed, 2 total
Tests:       2 passed, 2 total
```

所以第 9 節的 `useChat` 分層成立。後端不受影響：presenter 只輸出 `data: <JSON>`，不需要 import `ai`。

### 5.4 對設計的影響

程式架構第 9 節的前端分層改成以 `useChat` 為中心。改了三處：

- `domain/sessionView.ts`（把 Item 和串流事件合成畫面的訊息）縮小成 `domain/itemsToMessages.ts`：只把 Item 轉成 `UIMessage`。串流事件的合成交給 `useChat`。
- `adapters/uiMessageStream.ts`（自己解析 SSE）換成 `adapters/AiChatTransport.ts`：實作 `ChatTransport`，用 `parseJsonEventStream` 解析。
- `application/` 的 hooks 包 `useChat`。`domain/approval.ts` 改成讀 `UIMessage` 的 part。

### 5.5 實作時要注意

- **助理訊息的 id。** `start.messageId` 要每個 Run 一個，而且核准後的接續串流用同一個。測試時如果新的 Run 用了舊訊息的 id，會蓋掉舊訊息。
- **使用者訊息的 id 在用戶端產生**，和紀錄裡的 Item id 不同。重新整理後以紀錄為準。
- **一次有多個核准時，每按一次就存一次。** 規格 P-04 是每個呼叫各自決定，`DecideApproval` 每次寫一筆 `approval` Item。所以不能等 `useChat` 全部回應完才送。transport 不自己掃 part 判斷要送哪個決定，因為重新整理後，已決定的呼叫載入時就是 `approval-responded`，transport 沒有「已送過」的紀錄，會重送。改成由畫面明確指定：

  - 畫面的處理函式設 `pendingDecision = { callId, approved }`（一個 ref）。
  - 不是最後一個要決定的呼叫：先呼叫 `AiChatClient` 的 decision 端點（回應是 JSON），成功後再呼叫 `addToolApprovalResponse` 讓畫面更新。`sendAutomaticallyWhen` 要求 `pendingDecision != null`，所以這時不會自動送出。這個分支不設 `pendingDecision`。
  - 最後一個要決定的呼叫：設 `pendingDecision`，然後呼叫 `addToolApprovalResponse({ id, approved, options: { body: pendingDecision } })`。
  - `sendAutomaticallyWhen` 是 `pendingDecision != null && lastAssistantMessageIsCompleteWithApprovalResponses({ messages })`。
  - transport 的 `sendMessages` 一開始就讀 `body.callId` 和 `body.approved`，並立刻把 `pendingDecision` 清空，然後打那個呼叫的 decision 端點，收 SSE 接續執行。
  - 接續串流結束後，`useChat` 會再判斷一次是否自動送出（`ai/src/ui/chat.ts` 約 1228 到 1242 行，帶同一個 `body`）。`pendingDecision` 已清空，所以不會重送。伺服器用 `abort` 結束時，`useChat` 不會當成中斷，同樣要靠這一點擋住。
  - 載入已存的訊息時，已決定的呼叫轉成 `approval-responded`，還沒決定的是 `approval-requested`。所以只決定一個就重新整理，那個決定還在，另一個仍在等。
  - 連按：有決定請求還在處理時，鎖住其他核准卡片（按鈕停用）。否則按 A 的 JSON 請求還沒回來就按 B，B 會誤判自己不是最後一個。
  - 實測（`check-fixes.mjs`，情境：A 已決定並載入，B 還在等；`stored` 是已存的訊息）：

    ```
    before click: status ready posts 0
    posts: [ '{"callId":"call_b","approved":true}' ]
    [ 'step-start', 'tool-a:approval-responded', 'tool-b:output-available', 'step-start', 'text:"Done."' ]
    ```

    B 的決定只送出一次，A 沒有重送。

    `abort` 結束後不會再送，用另一支腳本（`check-abort.mjs`）對照：串流只有 `start`、`tool-approval-response`、`abort`，沒有 `start-step`，所以結束時所有核准都有回應。

    ```
    with pendingDecision condition: true   status=ready  posts=1 [ '{"callId":"call_b","approved":true}' ]
    with pendingDecision condition: false  status=error  posts=2 [ same decision twice ]
    ```

    有 `pendingDecision` 條件時只送一次；拿掉條件，`useChat` 在 `abort` 結束後又送了一次。

  - 沒有實測：兩個核准在畫面上連按的鎖，以及 JSON 回應的分支。這兩項在 P1-10 的端對端測試驗收。

- **停止。** `useChat.stop()` 只會中斷 fetch。文件把這種中斷視為斷線，不是取消（見 Chatbot Resume Streams 的警告）。要取消 Run，transport 的 `abortSignal` 不能直接取消伺服器的工作，要由使用者按「停止」時另外呼叫 `POST .../cancel`。
- **接回（A-07）。** 規格的 A-07 已改成「從目前 Run 的第一個 Item 重送，再接著送新的」。重送要先送 `start`（同一個 `messageId`）。還沒完成的 Item 要補送 `text-start` 加已累積的文字，不能只送缺開頭的 `text-delta`（3.4）。`afterSeq` 留作其他用戶端的下限。
- **`data-plan`。** 固定 `id` 取代先前的，只在同一則訊息裡成立。前一個 Run 的計畫留在舊訊息，畫面要取最新的那一個。
- **`GET /stream` 只在 Run 是 `running` 時串流。** `waiting_approval` 或已結束時伺服器回 204，transport 轉成 `null`。（H-03 把 `waiting_approval` 算進行中的 Run，這裡的「串流」不同：停在核准上的 Run 沒有東西可送，開著串流會讓 `useChat` 停在 `submitted`，之後按核准不會自動送出，卡片卡住。）端點在 P1-09 加入，只接這一台 backend 跑的 Run；Run 在別台時回 204，跨 backend 接回是 P2。
- **zod 版本。** `ai` 的 peer 是 `zod@^3.25.76 || ^4.1.8`。

## 6. 沒有驗證的事

- jest 探針只測了 import 和一段簡單的文字串流，沒有測核准和接回（那兩項在 Node 加 jsdom 的腳本裡測過，見 5.2）。
- TypeScript 5.8 編譯 `ai` 的型別定義。
- 真正的瀏覽器：`useChat` 的 `resume` 只測了掛載時重連，沒測分頁回到前景時的重連。
- 多個核准：畫面連按時鎖住卡片，和 decision 端點回 JSON 的那條路（5.5）。`pendingDecision` 的流程本身已實測。
- 在 Backstage 的 HTTP 堆疊（Express）上送 SSE：驗證用的是 Node 內建 `http`。
