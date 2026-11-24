---
'@kwkevinchan/backstage-plugin-ai-chat-backend': patch
---

`aiChat.maxToolOutputChars` must be at least 100; a smaller value stops the backend at startup. A cut tool output keeps the longest text whose serialized form fits the limit.
