---
'@kwkevinchan/backstage-plugin-ai-chat-backend': patch
---

Document TechDocs search with the `search:query` action of the Backstage search backend. The action runs as the user who sends the message, so with `permission.enabled` the results hold only the documents that user may read, each with its `document.location`. The plugin adds no search action of its own.
