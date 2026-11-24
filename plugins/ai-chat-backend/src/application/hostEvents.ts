/*
 * Copyright 2026 The backstage-plugin-ai-chat Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { HarnessEvent, RunOutcome } from '@kwkevinchan/ai-chat-harness';
import type { PausedReason, Principal, QueuedMessage, Run } from '../domain';

/**
 * The queue of a session when a run ended (IN-15): the messages, and whether
 * the queue waits for the user instead of sending the next one.
 */
export type QueueState = {
  items: QueuedMessage[];
  paused: boolean;
  pausedReason?: PausedReason;
  /** The run the queue started. Set only when this backend runs it. */
  nextRunId?: string;
};

/** What a subscriber of a run gets: the events of the loop, and the state of the queue. */
export type HostEvent = HarnessEvent | ({ type: 'queue.state' } & QueueState);

/**
 * What the supervisor does after a run left the loop and its status was
 * written (the end, or the wait for an approval). It returns the state of the
 * queue; `RunSupervisor` sends it to the subscribers before `run.ended`.
 */
export type AfterRun = (info: {
  run: Run;
  outcome: RunOutcome;
  /** Who started this loop. Only in memory: it is never stored. */
  principal: Principal;
}) => Promise<QueueState>;
