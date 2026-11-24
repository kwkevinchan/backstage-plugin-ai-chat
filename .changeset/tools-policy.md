---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Add the `aiChat.toolsets` and `aiChat.policy` settings, and the adapters that turn the actions registry into the tools of the agent loop: `ActionsToolGateway` and `ConfigAgentCatalog`. The backend reads and checks both settings at startup; the chat itself uses them once the agent loop replaces the current chat service. `aiChat.actions.include` and `aiChat.actions.exclude` are deprecated: the backend logs a warning at startup when either is set, and they are ignored when `toolsets` is set.
