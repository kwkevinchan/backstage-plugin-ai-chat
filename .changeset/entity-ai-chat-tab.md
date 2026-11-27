---
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Add an **AI chat** tab for entity pages. It lists the signed-in user's sessions bound to the entity, with their live status, and its **New chat** button opens the chat bound to that entity.

- Legacy frontend system: mount the new `EntityAiChatContent` component in an `EntityLayout.Route`.
- New frontend system: the plugin adds the `entity-content:ai-chat/entity-ai-chat` extension, enabled by default on every kind. Turn it off with `entity-content:ai-chat/entity-ai-chat: false` in `app.extensions`, or limit it to some kinds with an entity predicate in its `config.filter`.

The tab and the chat page share how the session list stays current: Backstage Signals when installed, polling while the browser tab is visible, and the **New reply** badge.
