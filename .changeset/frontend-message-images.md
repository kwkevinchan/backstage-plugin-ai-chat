---
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Attach images to a message.

- The box has Attach, and also takes a pasted or dropped image, when the model can read images. A draft shows a thumbnail, the upload, and a failure; removing it leaves it out of the message. The wrong type, a file over the size limit, or one image too many is not uploaded, and the box says why. While an upload is in progress, Send waits.
- A message shows its images. They are loaded with the signed-in request. An image that can no longer be read says so by name.
- On a new conversation, the first image creates the session, and the first message uses that session.
- Send is enabled when the draft has an uploaded image and no text.
- `AiChatApi` has `getInputConfig`, `uploadAttachment` and `readAttachment`.
