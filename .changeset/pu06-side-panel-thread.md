---
'@kwkevinchan/backstage-plugin-ai-chat': minor
'@kwkevinchan/backstage-plugin-ai-chat-react': patch
---

Finish aligning the side panel (`AiChatPanel`) with the assistant-ui message thread runtime:

- Support attaching images on the first message in the side panel draft composer (`DraftComposer`) as well as in active sessions.
- Move focus to the composer input when the side panel opens, close the panel on `Escape`, restore focus to the button that opened it (either the edge tab or `AiChatLauncher`), and expose `aria-expanded` on both buttons.
- Scope `AiChatPanelApi.subscribe` notifications strictly to `isOpen()` changes while keeping internal store subscriptions for panel session and launch state.
