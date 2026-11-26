---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-node': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': patch
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Add context providers and the entity of a session.

A backend module can register a context provider with `addContextProvider`. Before every model call, each provider returns text for the context of that step, or nothing. The model gets it in the system prompt as untrusted data, not as instructions, after the built-in providers `user` (the entity ref of the user and the refs they own through), `entity` (a few fields of the entity the session is bound to, read from the catalog as the user) and `plan` (the current plan). Each text is cut to 8000 characters, and all of them together to 16000. The loop waits at most 5 seconds for a provider; when one throws or does not answer, the model is told that this context is not available and the run goes on. A repeated id, or one of the built-in ids, stops the backend. `StepContext` has `sessionEntityRef`, the entity the session is bound to.

A session can be bound to one entity: `POST /sessions` with `entityRef`, or else the entity of the page of the first message. The ref needs a kind and is stored in lower case, the user must be able to read the entity, and the binding does not change. `POST /sessions` answers 400 for an entity that does not exist or that the user cannot read, with the same message. `GET /sessions?entityRef=` lists the sessions of the user bound to that entity, and `AiChatClient.listSessions` takes `entityRef`.

The backend depends on `@backstage/plugin-catalog-node` for the catalog service.
