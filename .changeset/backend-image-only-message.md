---
'@kwkevinchan/backstage-plugin-ai-chat-backend': minor
---

Accept a message that is only images.

Send, insert and queue take empty text when the message has at least one image. A message with no text and no image is still refused. A message with images and no text is sent to the model as image parts only.
