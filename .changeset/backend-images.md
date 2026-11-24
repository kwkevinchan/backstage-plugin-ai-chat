---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
'@kwkevinchan/backstage-plugin-ai-chat-common': minor
---

Add images in messages. A user uploads PNG, JPEG, WebP or GIF images to a session (`POST /sessions/:id/attachments?name=`, the bytes as the body) and names them in `attachmentIds` of a message (send, insert, queue). Only the owner of the session uploads and reads them (`GET /sessions/:id/attachments/:attachmentId`, with `nosniff`, `inline`, a sandboxing `Content-Security-Policy`, the stored type, and `private, no-cache` with an `ETag`). The type and the header of the file are checked, SVG is refused, and the size is checked before the body is read (413). An image that no message uses is deleted after 24 hours; at most 12 images wait in a session. `GET /input-config` tells a client what a message may carry.

The images go to the model server, so they are off unless `aiChat.llm.images` is `true`; `aiChat.input.images` has the limits (`maxPerMessage`, `maxBytes`, `maxBytesPerInput`, `maxPendingPerSession`, `tokensPerImage`). The images of the messages of one run may not be more than `maxBytesPerInput` bytes (an insert that would take them over gets 400 `TooManyImageBytes`), which must be at least `maxPerMessage` times `maxBytes`. A migration adds the table `attachments`.
