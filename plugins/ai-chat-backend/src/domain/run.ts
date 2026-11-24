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

import type {
  RunFence,
  RunStatus,
  RunUsage,
} from '@kwkevinchan/ai-chat-harness';

/**
 * One go of the agent loop in a session: from a message of the user to the
 * answer, over as many steps and approvals as it takes. A session has at most
 * one active run.
 */
export type Run = {
  id: string;
  sessionId: string;
  parentRunId?: string;
  status: RunStatus;
  /** Who runs the loop now; unset while nobody does (for example while waiting for an approval). */
  leaseOwner?: string;
  /** ISO 8601; the lease is not held after this time. */
  leaseExpiresAt?: string;
  usage: RunUsage;
  cancelRequested: boolean;
  endReason?: string;
  startedAt: string;
  endedAt?: string;
};

/** A run whose lease the caller holds, with the fence to write with. */
export type LeasedRun = Run & { fence: RunFence };
