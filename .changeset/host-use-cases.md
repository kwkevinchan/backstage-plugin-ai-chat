---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Add the use cases of the host on the new agent loop: create, read, list, update and delete a session, send a message, decide an approval, cancel a run and expire stale runs. `RunSupervisor` runs the loop in the background, renews the lease, ends the run with the lease it holds and marks the runs of this backend `expired` at shutdown. Runs and approvals work across backends. The decision of the user and every run of a tool that is not read-only go to the auditor. The routes still use the old chat; they move to the new use cases with the HTTP change.

New settings: `aiChat.runTimeoutSeconds` (default 300, at most 600; a run also stops before the token of the user expires), `aiChat.maxToolCallsPerRun` (default 30) and `aiChat.context.tokenBudget` and `aiChat.context.keepRecentSteps` for the context budget.
