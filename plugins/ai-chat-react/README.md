# @kwkevinchan/backstage-plugin-ai-chat-react

React entry points of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat)
for another frontend plugin: open the chat, show the result of an action with
your own component, and add references to a message. Depend on this package, not on
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

A `prompt` starts a new conversation and is sent at once as the signed-in user
(with `references`, it waits in the input instead; see below);
pass fixed text or values your plugin controls, not URL query parameters or
other untrusted input. An `entityRef` is sent with the messages of that
conversation. A value that is not an entity reference is left out, and the chat
still opens. With neither prop, the button only opens the panel.

`references` (entities of the catalog and text snippets) go into the box of
the panel for the next message: the user sees them above the input and can
remove them before sending. With `references`, a `prompt` is not sent: it goes
into the input of a new conversation, which has the focus, and the user sends it.
See [References](#references).

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

## Result components of actions

A plugin can show the result of an action in the chat with its own component,
for example a table instead of the JSON of the output. The chat keeps its own
row of the call (status, title, and the raw input and output, folded) and
shows the component under it. An action without a component keeps the default
row. The component never replaces the approval card: while a call waits for a
decision, only the card is shown, with Allow and Deny.

```tsx
import {
  AiChatSafeLink,
  type AiChatToolResult,
  type AiChatToolResultProps,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';

function ServicesTable({ status, output }: AiChatToolResultProps) {
  const services = (output as { services?: unknown })?.services;
  if (status !== 'complete' || !Array.isArray(services)) return null;
  return (
    <ul>
      {services.map(service => (
        <li key={String(service.name)}>
          <AiChatSafeLink href={service.url}>
            {String(service.name)}
          </AiChatSafeLink>
        </li>
      ))}
    </ul>
  );
}

export const listServicesResult: AiChatToolResult = {
  actionId: 'my-plugin:list-services',
  component: ServicesTable,
};
```

The component receives `actionId`, `input`, `status` (`running`, `complete`,
`failed`, `denied` or `unknown`), `output` when the call is complete, and
`errorText` when it failed or its result is not known. An output longer than
the limit of the backend is replaced by `{ text, originalLength }` (the first
part of its JSON and the full length), and a field that the administrator
hides arrives as the string `[redacted]`.

New frontend system: add an extension of `AiChatToolResultBlueprint` from the
`/alpha` entry point to your plugin. It attaches to the chat plugin, so the app
needs no code.

```tsx
import { AiChatToolResultBlueprint } from '@kwkevinchan/backstage-plugin-ai-chat-react/alpha';

const listServicesChatResult = AiChatToolResultBlueprint.make({
  name: 'list-services',
  params: listServicesResult,
});
```

Legacy frontend system: the app replaces `aiChatToolResultsApiRef` with the
components of its plugins:

```tsx
import { createApiFactory } from '@backstage/core-plugin-api';
import { createAiChatToolResultsApi } from '@kwkevinchan/backstage-plugin-ai-chat';
import { aiChatToolResultsApiRef } from '@kwkevinchan/backstage-plugin-ai-chat-react';

const app = createApp({
  apis: [
    createApiFactory({
      api: aiChatToolResultsApiRef,
      deps: {},
      factory: () => createAiChatToolResultsApi([listServicesResult]),
    }),
  ],
});
```

Rules:

- One component per action id. When two name the same id, the first one is
  used (the order of the list, or the order of the extension inputs on the new
  frontend system), and the chat warns in the console about the later one.
- The tools of the chat itself (`update_plan`, `load_skill`) keep their own
  view; a component for them is not used.
- A component that throws while it renders is left out, and the default row
  stays. The rest of the conversation is not affected.
- The input and the output are untrusted data: the model writes the input,
  and the output can contain text that the action read from anywhere. Never
  render them with `dangerouslySetInnerHTML`, and link only `http:`, `https:`
  and `mailto:` addresses. `AiChatSafeLink` does that and shows any other
  value as plain text; `isSafeLinkHref` is the same check.

## References

A message can carry references: `{ kind: 'entity', entityRef }` (the ref has a
kind) or `{ kind: 'text', text, title?, url? }` (`url` is an `http:` or
`https:` URL or a path that starts with `/`; another link is left out). The
chat reads an entity with the credentials of the user who sends the message.
A text goes to the model provider as it is: do not put secrets in it. A
message carries at most 5 references, or fewer when the administrator sets a
lower number; the box takes no more. A text over 4,000 characters is cut and
marked as truncated.

Put references in the box of the side panel:

```tsx
import { useAiChatPanel } from '@kwkevinchan/backstage-plugin-ai-chat-react';

function AskAboutSelection(props: { selection: string }) {
  const { open } = useAiChatPanel();
  return (
    <button
      type="button"
      onClick={() =>
        open({
          references: [
            { kind: 'text', text: props.selection, title: document.title },
          ],
        })
      }
    >
      Ask AI chat
    </button>
  );
}
```

`<AiChatLauncher references={[…]}>` does the same with a button.

### Reference sources

A reference source adds an item to the **Add reference** menu of the chat,
next to **Current page** and **Catalog entity**. When the user picks it, the
chat shows its component in a box above the input. The component calls
`onAdd` with references (more than once if it likes) and `onClose` when it is
done.

```tsx
import type {
  AiChatReferenceSource,
  AiChatReferenceSourceProps,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';

function DocsPagePicker({ onAdd, onClose }: AiChatReferenceSourceProps) {
  return (
    <button
      type="button"
      onClick={() => {
        onAdd([
          {
            kind: 'text',
            text: 'Install with yarn.',
            title: 'Setup',
            url: '/docs/setup',
          },
        ]);
        onClose();
      }}
    >
      Use the setup page
    </button>
  );
}

export const docsPageSource: AiChatReferenceSource = {
  id: 'docs-page',
  title: 'Documentation page',
  component: DocsPagePicker,
};
```

New frontend system: add an extension of `AiChatReferenceSourceBlueprint` from
the `/alpha` entry point to your plugin. It attaches to the chat plugin
(`api:ai-chat/reference-sources`), so the app needs no code.

```tsx
import { AiChatReferenceSourceBlueprint } from '@kwkevinchan/backstage-plugin-ai-chat-react/alpha';

const docsPageChatSource = AiChatReferenceSourceBlueprint.make({
  name: 'docs-page',
  params: docsPageSource,
});
```

Legacy frontend system: the app replaces `aiChatReferenceSourcesApiRef` with
the sources of its plugins:

```tsx
import { createApiFactory } from '@backstage/core-plugin-api';
import { createAiChatReferenceSourcesApi } from '@kwkevinchan/backstage-plugin-ai-chat';
import { aiChatReferenceSourcesApiRef } from '@kwkevinchan/backstage-plugin-ai-chat-react';

const app = createApp({
  apis: [
    createApiFactory({
      api: aiChatReferenceSourcesApiRef,
      deps: {},
      factory: () => createAiChatReferenceSourcesApi([docsPageSource]),
    }),
  ],
});
```

Rules:

- The menu lists the sources in their order. When two have the same id, the
  first one is used and the chat warns in the console about the later one. A
  source without an id, a title or a component is not used.
- While the box is full, the items of the sources are off.
- A reference the backend would not take (an entity ref without a kind, an
  empty text) is not added. The same entity or the same snippet is added once.
- A component that throws is replaced by a short error; the box and the
  conversation stay.
