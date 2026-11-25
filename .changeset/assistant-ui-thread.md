---
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Build the conversation on the unstyled primitives of assistant-ui
(`@assistant-ui/react` 0.15.38 and `@assistant-ui/react-markdown` 0.14.26,
pinned). The state stays in the chat hook; the plugin connects it to
assistant-ui with `useExternalStoreRuntime`.

- The messages, the tool calls and the approval cards render through the
  thread and message primitives. The approval card answers through the tool
  props of assistant-ui and shows the same states as before: waiting, allowed,
  denied, who decided and when, done, failed, result unknown and did not run.
- The view follows a new answer to its end while it is at the end.
- Answers are Markdown with GitHub Flavored Markdown, so tables, strike-through
  show. Images are not rendered, HTML is shown as text, and a
  link keeps only an `http`, `https` or `mailto` target.
- A bare address followed directly by a quote or a brace now takes those
  characters into the link, as GitHub Flavored Markdown does.
- The input box uses the composer primitives with the buttons of
  `@backstage/ui`. While a run goes on, Enter adds the message to the run and
  Ctrl or Cmd with Enter queues it, as before.
