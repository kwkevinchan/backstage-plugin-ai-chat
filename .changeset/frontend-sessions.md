---
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Breaking change: the page talks to the new backend API and stream. Release it together with `@kwkevinchan/backstage-plugin-ai-chat-backend` (the page stops working with the old backend, and the old page stops working with the new backend).

- The page uses `useChat` of the AI SDK with a transport for the backend. The stream shows the answer word by word, a tool call as a row, and a call that is not read-only as a card with Allow and Reject.
- Every session has its own URL, `/ai-chat/<session id>`; opening it loads that session. In the legacy frontend system mount the page with `path="/ai-chat/*"` when you do not use `FlatRoutes`.
- Every Allow or Reject is stored at once. After a reload the decisions that are stored stay, the other calls still wait, and nothing is sent twice. A run that goes on is followed, and a run whose decisions are all stored is carried on when the session opens.
- Stop asks the backend to cancel the run, also while it waits for a decision.
- New states: the run expired or was stopped before it answered (send the message again), a call whose result is not known, a call that did not run.
- Every message carries the page and the entity: open the chat with `/ai-chat?entityRef=component:default/my-service`. The backend stores the page with the message and tells the model where the user is in one line before the text.
- The approval card shows the title and the description of the tool, why it asks, and who decided it and when. The buttons are Allow and Deny.
- The toolsets of a session can be switched on and off in the page.
- Notes of the backend about the context (`data-notice`) are shown by their code.
- The types of the API are in `@kwkevinchan/backstage-plugin-ai-chat-common`; the package no longer exports `/common`, and `AiChatApi` has new methods (`listSessions`, `createSession`, `getSession`, `updateSession`, `deleteSession`, `listToolsets`, `sendMessage`, `decide`, `resume`, `follow`, `cancelRun`).
