---
'@kwkevinchan/backstage-plugin-ai-chat': patch
---

Resolve root-relative Markdown links starting with a single `/` against `app.baseUrl` in `MarkdownText`, allowing only same-origin `http:`/`https:` targets while keeping protocol-relative (`//`), backslash (`/\`), and non-HTTP(S) links blocked.
