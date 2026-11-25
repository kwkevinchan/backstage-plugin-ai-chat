# @kwkevinchan/backstage-plugin-ai-chat-node

Extension point for backend modules of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat).

A module depends on this package, and not on the backend plugin or the
harness. It receives `aiChatHarnessExtensionPoint` and can call `addAgent`
to register an agent: a system prompt, toolsets, skills, a model, limits and
`planning: required`. `skills`, `model`, `limits` and `planning` are recorded
on the agent and are not applied yet.

An id that the configuration also defines, or that another module already
registered, stops the backend. The system prompt is wrapped with the same
built-in rules as a configured agent.

`addHook` registers a lifecycle hook: `beforeModelCall`, `beforeToolCall`,
`afterToolCall` or `onRunEnd`. `beforeToolCall` can deny a call or make it
wait for an approval, and never lets a call run that the policy asks an
approval for. A hook that throws fails closed. `onRunEnd` gets the stored
status of a run once it ended, and the user ref without credentials.

Further methods (context providers, skills, a model client) are added on
later items, together with the loop calling them.

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
