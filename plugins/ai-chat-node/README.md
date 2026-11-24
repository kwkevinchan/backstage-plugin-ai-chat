# @kwkevinchan/backstage-plugin-ai-chat-node

Extension point for backend modules of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat).

A module depends on this package, and not on the backend plugin or the
harness. It receives `aiChatHarnessExtensionPoint` and can call:

| Method               | Adds                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `addAgent`           | An agent: system prompt, toolsets, skills, model, limits, planning   |
| `addContextProvider` | Text that will be added to the model input on every step             |
| `addSkill`           | A skill id, a one-sentence description, and a function that loads it |
| `addHook`            | A function for one of the four hook names                            |
| `setModelClient`     | A model client for a model id                                        |

The hook names are `beforeModelCall`, `beforeToolCall`, `afterToolCall` and
`onRunEnd`.

The backend records these at startup. It does not call them yet: a context
provider is not added to the input, a skill is not loaded, a hook does not
run, `planning: required` does not change the first step, and a model client
registered here is not the client the loop calls. An agent id that the
configuration also defines, or that another module already registered, stops
the backend.

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
        harness.addContextProvider({
          id: 'site',
          async provide() {
            return 'The site is example.com.';
          },
        });
      },
    });
  },
});
```

`plugins/ai-chat-backend-module-example` is that module, ready to install.
Agents can also be written in `aiChat.agents`; see the
[README of the repository](https://github.com/kwkevinchan/backstage-plugin-ai-chat#readme).
