---
'@kwkevinchan/ai-chat-harness': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Messages can carry references: entities of the catalog and text snippets.

A message that is sent, inserted or queued, and a change of a queued message, take an optional `references` list. A reference is `{ kind: 'entity', entityRef }` or `{ kind: 'text', text, title?, url? }`. A message has at most 5 references; `aiChat.input.references.maxPerMessage` sets a lower number. A text has at most 4,000 characters, a title at most 200, and a link is an `http` or `https` URL or a path. A request over a limit is refused with 400.

The backend reads each entity with the credentials of the user before it writes the message, and keeps what it read on the message. An entity that the user cannot read is kept as not readable, and the model gets none of its details. A queued message keeps the references it was queued with and is sent with them. The model reads the references in the message, after the line of the page and before the text, with every value written as JSON. A user a session is shared with sees the references of its messages, and a copy of the session takes them.

`GET /input-config` answers the limits in `references`. The core adds `MessageReference` and `ReferencedEntity`, and `user_message` has an optional `references`. The common package adds the request and response types, the limits and `isReferenceUrl`.

The backend has a new migration: `queued_messages.message_references`.
