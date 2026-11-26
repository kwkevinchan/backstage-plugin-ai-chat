---
'@kwkevinchan/backstage-plugin-ai-chat': minor
---

Show the queue and the inserted messages with the queue primitives of
assistant-ui. The queue stays in the backend: the plugin connects it to
assistant-ui with a queue adapter that keeps no state of its own.

- While a run goes on, Enter adds the message to the run and Ctrl or Cmd with
  Enter, or the Queue button, queues it, as before. While the run waits for a
  decision, both queue. With no run, both send.
- A queued message can be edited, deleted, moved up or down, and, while the
  run is running, sent now: it leaves the queue and is added to the run. When
  it was sent or removed elsewhere, when the run is no longer running, or when
  the run takes no more messages, the queue says so and shows what is stored.
- A queued message shows how many images it has.
- The queue says when it is full (`aiChat.input.queue.maxMessages`).
- A paused queue, Continue, and the hint above the box while the queue is
  paused are as before.
