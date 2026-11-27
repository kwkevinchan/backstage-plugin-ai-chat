---
'@kwkevinchan/backstage-plugin-ai-chat-backend': patch
---

Clarify the `aiChat.llm.images` and `aiChat.models.<id>.images` config descriptions: `aiChat.llm.images` is the global switch for image attachments (attach button, uploads, and messages with images) as well as the default model's image capability, while `aiChat.models.<id>.images` only controls whether images are sent to that model or replaced with a text description. Behavior is unchanged.
