---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

The owner of a session can share it, read-only, with a user or a group: `GET` and `POST /sessions/{id}/shares`, `PATCH` and `DELETE /sessions/{id}/shares/{shareId}`, and the client methods `listShares`, `createShare`, `updateShare` and `revokeShare`. A snapshot (the default) shows the session up to the share and moves on when the owner refreshes it. A live share shows what comes next too, until it expires (`aiChat.sharing.live.defaultHours`, at most `maxHours`), and then stays as it was then; `enabled: false` refuses live shares. The owner can leave the tool output out; a live share leaves out the tool output written after the share until the owner shows it. The sharee reads the session, the images of the messages they see and the stream of a live share, and cannot send, decide an approval or change anything: those requests answer as not found. Making, changing and cancelling a share are written to the auditor (`session-share`, `session-share-update`, `session-share-revoke`). With a policy that denies `ai-chat.session.read`, the owner can no longer follow a run or read an image either, as for reading the session.
