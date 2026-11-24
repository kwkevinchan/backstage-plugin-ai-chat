---
'@kwkevinchan/backstage-plugin-ai-chat-backend': patch
---

Clarify that `aiChat.input.images.tokensPerImage` is an estimate of how many tokens one image counts in the context budget. It has not been measured against a real model. The default stays 1600, and the behavior is unchanged.
