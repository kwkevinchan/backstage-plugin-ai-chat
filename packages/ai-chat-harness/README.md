# @kwkevinchan/ai-chat-harness

Core of the AI chat harness: the agent loop, the tool policy and the model
input. It has no dependency on Backstage, HTTP or a database, and it is tested
with a scripted model and an in-memory log.

The code has two circles, and the dependencies point inward:

| Folder            | Holds                                                 |
| ----------------- | ----------------------------------------------------- |
| `src/domain`      | Types and pure functions. No `async`, no I/O          |
| `src/application` | Use cases and the ports they need                     |
| `src/testing`     | The `/testing` entry point: fakes and in-memory ports |

`yarn lint` enforces this (see `.eslintrc.js` and `src/lintRules.test.ts`):
`domain` does not import `application`, neither imports `@backstage/*`,
`express` or `knex`, and the whole package never imports `@backstage/*`.
Neither circle can run code, reach the file system or open a network: no
import of `fs`, `child_process`, `vm`, `worker_threads`, `cluster`, `module`,
`net`, `http`, `https` or `dgram`, no `eval` or `new Function`, and no
`require`, `process`, `globalThis`, `global` or dynamic `import()` in the
source (test files may use the globals of the test runner).
The only way to act is a tool, behind the `ToolGateway` port.

Part of the unofficial
[AI chat for Backstage](https://github.com/kwkevinchan/backstage-plugin-ai-chat).
