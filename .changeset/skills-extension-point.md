---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-node': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Add `aiChatHarnessExtensionPoint.addSkill`, `aiChat.skills.directories` (`SKILL.md` discovery with lazy body loading), agent-level skill filtering, and the read-only built-in `load_skill` tool (`X-04`, `D-22`).

An agent whose `skills` names an id that no directory or module registers stops the backend at startup.
