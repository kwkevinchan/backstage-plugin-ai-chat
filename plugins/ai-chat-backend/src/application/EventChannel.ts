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

/**
 * A queue of events for one reader. `push` never waits; the reader takes the
 * events in order with `for await`. When the reader stops (`break`, `return`
 * or an error in its loop) the channel calls `onClose` once and drops what is
 * left.
 */
export class EventChannel<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;

  constructor(private readonly onClose: () => void = () => {}) {}

  /** Adds an event. Does nothing once the channel is closed. */
  push(event: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  /**
   * The events that are queued and not yet read. A caller that subscribed and
   * has not started reading uses this to see what arrived while it did
   * something else (the read of the log, for a client that joins a run).
   */
  buffered(): T[] {
    return [...this.queue];
  }

  /** No more events: the reader gets what is queued, then the end. */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({
            value: this.queue.shift() as T,
            done: false,
          });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>(resolve => {
          this.waiting = resolve;
        });
      },
      return: () => {
        const wasClosed = this.closed;
        this.closed = true;
        this.queue.length = 0;
        this.waiting?.({ value: undefined, done: true });
        this.waiting = undefined;
        if (!wasClosed) this.onClose();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
