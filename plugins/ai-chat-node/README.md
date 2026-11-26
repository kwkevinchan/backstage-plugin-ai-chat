# @kwkevinchan/backstage-plugin-ai-chat-node

Extension point for backend modules of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat).

A module depends on this package, and not on the backend plugin or the
harness. It receives `aiChatHarnessExtensionPoint` and can call `addAgent`
to register an agent (a system prompt, toolsets, skills, a model, limits and
`planning: required`; `limits` and `planning` are recorded on the agent and
are not applied yet) and `addSkill` to register a skill whose full
instructions are loaded lazily when the model calls `load_skill`.

An id that the configuration also defines, or that another module already
registered, stops the backend. The system prompt of an extension agent is
wrapped with the same built-in rules as a configured agent.

`addHook` registers a lifecycle hook: `beforeModelCall`, `beforeToolCall`,
`afterToolCall` or `onRunEnd`. `beforeToolCall` can deny a call or make it
wait for an approval, and never lets a call run that the policy asks an
approval for. A hook that throws fails closed. `onRunEnd` gets the stored
status of a run once it ended, and the user ref without credentials.

`addModelClient(id, client)` adds a model, which an agent names with `model`.
The client declares what the model can do in `capabilities`
(`parallelToolCalls`, `images`); the loop gives images only to a model that
reads them. The images of a message carry no bytes: `opts.readImage(image)`
of `stream` returns `{ mediaType, bytes }` from the attachments of the
session, or `undefined` for an image that was deleted. It only adds a model:
an id of the configuration (`default`, or a key of `aiChat.models`) or of
another module stops the backend. The rate limit of `requestsPerMinute`
applies to the models of the configuration only.

Context providers are added on a later item, together with the loop calling
them.

```ts
import { createBackendModule } from '@backstage/backend-plugin-api';
import { aiChatHarnessExtensionPoint } from '@kwkevinchan/backstage-plugin-ai-chat-node';

export default createBackendModule({
  pluginId: 'ai-chat',
  moduleId: 'example',
  register(env) {
    env.registerInit({
      deps: { harness: aiChatHarnessExtensionPoint },
      async init({ harness }) {
        harness.addAgent({
          id: 'guide',
          systemPrompt: 'You help people find documentation on example.com.',
          skills: ['getting-started'],
        });
        harness.addSkill({
          id: 'getting-started',
          description: 'Walks new readers through docs on example.com.',
          load: async () => 'Start with the docs index on example.com.',
        });
      },
    });
  },
});
```

`plugins/ai-chat-backend-module-example` in this repository is a private
example of that module, to copy from. Agents can also be written in
`aiChat.agents`; see the
[README of the repository](https://github.com/kwkevinchan/backstage-plugin-ai-chat#readme).
