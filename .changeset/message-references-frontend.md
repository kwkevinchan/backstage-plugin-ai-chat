---
'@kwkevinchan/backstage-plugin-ai-chat': minor
'@kwkevinchan/backstage-plugin-ai-chat-react': minor
---

Show what a message carries above the input box, and let the user add references.

- A tag shows the page the user is on, sent with each message as before. Its × leaves the page out: the tag becomes a faint "＋ Current page" that adds it back. The page stays out until the user is on another page. While it is out, no message, insert, queued message, decision or resume sends `page`.
- **Add reference** adds entities of the catalog (a search by name and title, like the `EntityPicker` of the Scaffolder) and the references of the sources other plugins register. Each reference has a tag with a ×. The box takes no more references than `GET /input-config` allows, cuts a text over the limit and marks it as truncated. The references leave the box when the message is sent. Images do not count.
- A message shows its references above its text, also to a user it is shared with.
- `useAiChatPanel().open({ references })` and `<AiChatLauncher references>` put references in the box of the side panel. With references, a prompt is not sent: it goes into the input of a new conversation, and the user sends it.
- `@kwkevinchan/backstage-plugin-ai-chat-react` adds `AiChatReference`, `AiChatReferenceSource`, `AiChatReferenceSourceProps`, `AiChatReferenceSourcesApi` and `aiChatReferenceSourcesApiRef`, and `AiChatReferenceSourceBlueprint` in `/alpha`. `@kwkevinchan/backstage-plugin-ai-chat` adds `createAiChatReferenceSourcesApi` for the legacy frontend system and collects the blueprint on the new one.
