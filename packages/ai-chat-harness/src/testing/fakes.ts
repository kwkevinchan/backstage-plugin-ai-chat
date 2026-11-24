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
  Clock,
  IdGenerator,
  RunControl,
  RunFence,
  RunUsage,
} from '@kwkevinchan/ai-chat-harness';

/** A clock that moves only when the test says so. @public */
export class FakeClock implements Clock {
  private ms: number;

  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.ms = start.getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

/** Ids `prefix-1`, `prefix-2`, and so on. @public */
export class SequentialIdGenerator implements IdGenerator {
  private count = 0;

  constructor(private readonly prefix = 'id') {}

  next(): string {
    this.count += 1;
    return `${this.prefix}-${this.count}`;
  }
}

/**
 * A `RunControl` for tests. It records the heartbeats and the usage, and asks
 * to stop after the number of heartbeats you set with `cancelAtHeartbeat`.
 *
 * @public
 */
export class FakeRunControl implements RunControl {
  heartbeats = 0;
  /** The usage of every `recordUsage` call, in order. */
  readonly usage: RunUsage[] = [];
  private cancelAt: number | undefined;

  /** The heartbeat with this number (1 is the first) and later ones ask to stop. */
  cancelAtHeartbeat(count: number): void {
    this.cancelAt = count;
  }

  async heartbeat(_fence: RunFence): Promise<{ cancelRequested: boolean }> {
    this.heartbeats += 1;
    return {
      cancelRequested:
        this.cancelAt !== undefined && this.heartbeats >= this.cancelAt,
    };
  }

  async recordUsage(_fence: RunFence, usage: RunUsage): Promise<void> {
    this.usage.push(usage);
  }
}
