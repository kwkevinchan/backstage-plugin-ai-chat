---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
'@kwkevinchan/backstage-plugin-ai-chat-node': patch
---

Add the built-in `update_plan` tool (`X-06`, `X-07`, `D-07`). Every agent can write a plan; the current plan is in the context of every step, and the chat shows each update as a checklist. An agent with `planning: required` gets only `update_plan` in the first step of a run. `readCurrentPlan` reads the current plan, also when a summary covers it.

`ItemLog` has a new method, `latestPlanUpdate`, that every implementation of the log needs. `currentPlan(items)` is removed; use `readCurrentPlan`. An administrator can turn the tool off with `policy: { update_plan: deny }`.
