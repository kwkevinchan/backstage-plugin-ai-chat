---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-node': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend-module-example': minor
---

Add `aiChat.agents` and the backend extension point.

An installation can define agents in configuration: a system prompt, toolsets, skills, a model, limits and `planning: required`. Without `aiChat.agents`, the only agent is still `default` (the built-in rules plus `aiChat.systemPrompt`). A wrong value stops the backend at startup.

`@kwkevinchan/backstage-plugin-ai-chat-node` exports `aiChatHarnessExtensionPoint`. A backend module can register agents, context providers, skills, hooks and model clients, and it depends only on that package. The example module `@kwkevinchan/backstage-plugin-ai-chat-backend-module-example` registers one agent and one context provider.

The loop records these and does not call them yet. A context provider is not added to the input, a skill is not loaded, a hook does not run, `planning: required` does not limit the first step, and a registered model client is not used.
