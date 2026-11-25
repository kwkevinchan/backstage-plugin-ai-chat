# Example backend module

This directory is a private example in the repository. Copy it when you write
a backend module of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat).
It is not published, and it is not a package to install.

It registers one agent, `guide`. The text mentions `example.com` only. A
module depends only on `@kwkevinchan/backstage-plugin-ai-chat-node` and the
Backstage public API.

The demo backend in this repository mounts it so the smoke tests can start.
If `aiChat.agents` also defines `guide`, the backend does not start.
