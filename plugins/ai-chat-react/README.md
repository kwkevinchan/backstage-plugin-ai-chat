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

The button opens the side panel through the `aiChatPanelApiRef` Utility API
registered by `@kwkevinchan/backstage-plugin-ai-chat`. When that plugin is not
installed in the app, `AiChatLauncher` renders nothing (`null`). Pass `className`
to style the button.

A `prompt` starts a new conversation and is sent at once as the signed-in user;
pass fixed text or values your plugin controls, not URL query parameters or
other untrusted input. An `entityRef` is sent with the messages of that
conversation. A value that is not an entity reference is left out, and the chat
still opens. With neither prop, the button only opens the panel.

`useAiChatPanel()` reads `{ isOpen, open, close }` from `aiChatPanelApiRef`
(or `{ isOpen: false, open, close }` with no-op handlers when the API is not
registered). `open()` with no prompt and no entity reference does not replace the
conversation. `close()` hides the panel and leaves the conversation mounted.

`aiChatPanelApiRef` and `AiChatPanelApi` are also exported for plugins or tests
that read or mock the Utility API directly.

The chat plugin mounts the panel once, outside the page routes, so a page
change does not unmount the conversation. On the legacy frontend system the
app renders `<AiChatPanel>` once, inside the router and outside the routes.
The new frontend system mounts it with the plugin.
