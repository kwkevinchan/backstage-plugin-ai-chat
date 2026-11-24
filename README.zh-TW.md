# Backstage 外掛：AI 對話

> **非官方。** 這是社群外掛，與 Backstage 專案無隸屬、背書或支援關係。

在 [Backstage](https://backstage.io) 裡和語言模型對話。模型可以**以登入者的身分**呼叫
Backstage actions registry 裡的 action：

- 只讀取的 action（`readOnly: true`）立刻執行。
- **其他所有 action 都會停下來，等使用者在對話裡核准。** 核准卡片會顯示完整的輸入；
  按 **Allow** 只會執行那份輸入。

對話本身不認識任何 action 來源。後端有註冊 action 的外掛都能用：catalog、
[Temporal 外掛](https://github.com/kwkevinchan/backstage-plugin-temporal)、自己寫的外掛。

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
頁面在 `/ai-chat`。舊前端系統的接法見[英文 README](README.md#frontend-legacy-frontend-system)。

## 設定

```yaml
aiChat:
  llm:
    baseUrl: https://api.openai.com/v1 # 任何相容 OpenAI Chat Completions 的伺服器
    apiKey: ${AI_CHAT_API_KEY}
    model: gpt-4o-mini
  maxTurns: 10
  actions: # 已淘汰，改用 toolsets；啟動時會記警告
    include: ['catalog:*']
backend:
  actions:
    pluginSources: [catalog] # 對話只看得到這些外掛的 action
```

`aiChat.toolsets`（工具分組，`default: true` 的組在新對話預設開啟，`egress: true`
的組即使唯讀也要核准）和 `aiChat.policy`（`{action id: allow|ask|deny}`）取代
`actions.include`、`actions.exclude`。啟動時會讀取並檢查，值不對會讓後端無法啟動。
`allow` 只對標了 `readOnly: true` 的 action 有效；沒標的當成不是唯讀，仍然要核准，
並在 log 記一筆警告。這一版的對話仍然使用 `include`、`exclude`，新設定在新的
agent 迴圈接上之後生效。細節見[英文 README](README.md#toolsets-and-policy)。

## 核准的規則

- 核准時執行的是**後端存起來的輸入**；`approve` 不接受請求帶來的新輸入。
- 一次決定只會被接受一次（資料庫裡的條件式更新），而且只有對話的擁有者能決定。
- 不是唯讀的 action，沒有核准就絕不執行；唯讀與否看 actions service 的屬性，不看模型的說法。
- 只有不是唯讀的 action 的核准、拒絕與執行會寫入 Backstage auditor；唯讀的 action 執行時不稽核。
- 完整的安全說明、API 與試用方式見[英文 README](README.md)。

## 授權

[Apache License 2.0](LICENSE)。
