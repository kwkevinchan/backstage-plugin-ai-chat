---
'@kwkevinchan/backstage-plugin-ai-chat-react': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Add `@kwkevinchan/backstage-plugin-ai-chat-react`, with `AiChatLauncher` and `useAiChatPanel()`. Another plugin opens the chat and passes a prompt and an entity reference. The chat plugin mounts a side panel that keeps the open conversation when the page changes. On the legacy frontend system, render `AiChatPanel` once inside the router and outside the routes. The new frontend system mounts that panel with the plugin.
