---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-node': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Add lifecycle hooks to the extension point of `@kwkevinchan/backstage-plugin-ai-chat-node`: `addHook` registers `beforeModelCall`, `beforeToolCall`, `afterToolCall` and `onRunEnd`.

`beforeToolCall` can deny a call or tighten its policy to `ask`, and never relaxes `ask`. A hook that throws or returns a value of the wrong shape fails closed. `afterToolCall` can change a tool result; the changed result is stored and streamed the same way, and its output is cut to `maxToolOutputChars`. `onRunEnd` runs once after the backend stored the end of a run, with the stored status (`completed`, `failed`, `cancelled` or `expired`), and the run does not wait for it. A stop or a timeout does not wait for a hook that does not answer.
