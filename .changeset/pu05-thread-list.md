---
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Migrate the conversation sidebar in `ChatPage` to assistant-ui's `useRemoteThreadListRuntime` and `ThreadListPrimitive` / `ThreadListItemPrimitive`, adding search, pin/unpin, inline rename, archive/unarchive, live activity badges (with optional Backstage Signals subscription and visibility-aware fallback polling), and forwarding `liveActivity` to `SessionView`.
