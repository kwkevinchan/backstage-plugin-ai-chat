# @kwkevinchan/backstage-plugin-ai-chat-react

React entry points that open the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat)
from another frontend plugin. Depend on this package, not on
`@kwkevinchan/backstage-plugin-ai-chat`.

```sh
yarn --cwd packages/app add @kwkevinchan/backstage-plugin-ai-chat-react
```

```tsx
import { AiChatLauncher } from '@kwkevinchan/backstage-plugin-ai-chat-react';

<AiChatLauncher
  prompt="where is this component?"
  entityRef="component:default/example.com"
>
  Ask about example.com
</AiChatLauncher>;
```

The button opens the side panel that the chat plugin renders. A prompt starts
a new conversation and is sent at once. An entity reference is sent with the
messages of that conversation. A value that is not an entity reference is
left out, and the chat still opens. With neither prop, the button only opens
the panel.

`useAiChatPanel()` opens and closes the same panel from code. `open()` with
no prompt and no entity reference does not replace the conversation.
`close()` hides the panel and leaves the conversation mounted.

The chat plugin mounts the panel once, outside the page routes, so a page
change does not unmount the conversation. On the legacy frontend system the
app renders `<AiChatPanel>` once, inside the router and outside the routes.
The new frontend system mounts it with the plugin.
