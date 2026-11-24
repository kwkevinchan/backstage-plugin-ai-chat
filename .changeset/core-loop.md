---
'@kwkevinchan/ai-chat-harness': minor
---

Add the agent loop of the core: the ports (`ItemLog`, `ModelClient`, `ToolGateway`, `RunControl`, `Clock`, `IdGenerator`), `AdvanceRun` with the model call and the tool execution, and the `HarnessEvent` and `RunOutcome` types. Add `needsApproval` to the domain. The new `/testing` entry has `ScriptedModel`, `InMemoryItemLog`, `FakeToolGateway`, `itemLogContract` and small fakes for the clock, the ids and the run control.
