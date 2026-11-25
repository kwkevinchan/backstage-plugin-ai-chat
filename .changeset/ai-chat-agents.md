---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-node': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Add `aiChat.agents` and the backend extension point.

An installation can define agents in configuration: a system prompt, toolsets, skills, a model, limits and `planning: required`. Without `aiChat.agents`, the only agent is still `default` (the built-in rules plus `aiChat.systemPrompt`). A wrong value stops the backend at startup.

`@kwkevinchan/backstage-plugin-ai-chat-node` exports `aiChatHarnessExtensionPoint`. A backend module can register agents, and it depends only on that package. The loop records `skills`, `model`, `limits` and `planning` on the agent and does not apply them yet.

An agent a module registers receives the same built-in prompt rules as a configured agent.
