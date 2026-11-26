---
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Attach images to a message.

When the model reads images (`aiChat.llm.images`), the message box has an Attach button, and takes a pasted or dropped image. The screen checks the type, the size and the count from `GET /input-config` before an upload, and says why it does not take a file. An image is uploaded when it is added: its thumbnail shows it uploading, or the reason it failed. A message is sent when its images are uploaded; one with a failed image stays in the box. A message can be only images. Sent, inserted and queued messages carry their images.

The images of a message are loaded with the request of the user and shown from an object URL, which is revoked when the image changes or goes away. An image that cannot be read shows its name and "The image no longer exists." When the model reads no images, there is no Attach button, and a pasted or dropped image is not taken.

On the new conversation page, the first image creates the conversation, and the first message goes to it with the toolsets chosen last.
