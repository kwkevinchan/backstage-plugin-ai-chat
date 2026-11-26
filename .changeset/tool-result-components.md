---
'@kwkevinchan/backstage-plugin-ai-chat-react': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Add result components for actions (`B-03`). Another plugin registers a component for an action id; the chat shows it under its own row of the call and keeps the approval card. On the new frontend system, add an extension of `AiChatToolResultBlueprint` from `@kwkevinchan/backstage-plugin-ai-chat-react/alpha`; on the legacy frontend system, replace `aiChatToolResultsApiRef` with `createAiChatToolResultsApi([...])` from `@kwkevinchan/backstage-plugin-ai-chat`. The first component for an id is used, a later one is left out with a console warning, the tools of the chat keep their own view, and a component that throws falls back to the default row. `AiChatSafeLink` and `isSafeLinkHref` link only `http:`, `https:` and `mailto:` addresses.
