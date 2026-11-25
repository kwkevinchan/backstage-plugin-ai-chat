---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
---

A session can record a read-only share to a user or a group. Reading a session checks the permission `ai-chat.session.read`. The owner still sees the whole session. Someone a share names sees only the items that share allows, and a tool output past the share's bound keeps its status with the text "not shared". Anyone else gets the same not-found answer as before. A permission policy can narrow that with `aiChatSessionConditions` (`isSessionOwner`, `isSharedWith`) and `createAiChatConditionalDecision`. A default-deny policy has to allow this permission, or every session opens as not found. `aiChat.sharing.live` sets whether a live share is allowed (`enabled`, default true), the life used when nobody picks one (`defaultHours`, default 24) and the longest life (`maxHours`, default 72). Leaving the block out uses those defaults. Creating or changing a share is not in this version.
