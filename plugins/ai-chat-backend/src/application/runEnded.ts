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

import type { Hooks, RunSummary } from '@kwkevinchan/ai-chat-harness';
import type { Run } from '../domain';
import type { Logger } from './ports';

/**
 * Tells the `onRunEnd` hooks that a run ended. The caller calls it once it
 * changed the status of the run itself, with the run as stored; a run that
 * waits for an approval has not ended and is ignored. It returns at once: the
 * run does not wait for the hooks.
 */
export type RunEnded = {
  (info: { run: Run; agentId: string; userRef: string }): void;
  /**
   * Waits until the hooks of every run that ended have finished, or `ms`
   * passed, whichever comes first. The shutdown calls it, so that the hooks
   * still have the database and the other services.
   */
  drain(ms: number): Promise<void>;
};

/**
 * How long one `onRunEnd` hook may take before the next one runs, and how
 * long the shutdown waits for the hooks that still run.
 */
export const RUN_END_HOOK_TIMEOUT_MS = 10_000;

/**
 * Runs the hooks one after the other, in the background. A hook that throws
 * does not stop the next one (the registry logs the error with the name of
 * the hook). A hook that takes longer than `timeoutMs` is logged and no
 * longer waited for.
 */
export function createRunEnded(deps: {
  hooks: readonly Hooks['onRunEnd'][];
  logger: Logger;
  timeoutMs?: number;
}): RunEnded {
  const { hooks, logger } = deps;
  const timeoutMs = deps.timeoutMs ?? RUN_END_HOOK_TIMEOUT_MS;
  const running = new Set<Promise<void>>();
  const ended = ({ run, agentId, userRef }: Parameters<RunEnded>[0]): void => {
    if (hooks.length === 0) return;
    const status = run.status;
    if (
      status !== 'completed' &&
      status !== 'failed' &&
      status !== 'cancelled' &&
      status !== 'expired'
    ) {
      return;
    }
    const summary: RunSummary = {
      sessionId: run.sessionId,
      runId: run.id,
      agentId,
      userRef,
      status,
      ...(run.endReason !== undefined && { endReason: run.endReason }),
      usage: { ...run.usage },
    };
    const chain = (async () => {
      // The caller goes on first, also when a hook does its work before it
      // returns a promise.
      await Promise.resolve();
      for (const hook of hooks) {
        const finished = await withTimeout(
          new Promise<void>(resolve =>
            resolve(hook({ ...summary, usage: { ...summary.usage } })),
          ).catch(() => undefined),
          timeoutMs,
        );
        if (!finished) {
          logger.warn(
            `An onRunEnd hook did not finish in ${timeoutMs} ms; the next one runs`,
            { runId: run.id },
          );
        }
      }
    })();
    running.add(chain);
    void chain.finally(() => running.delete(chain));
  };
  const drain = async (ms: number): Promise<void> => {
    if (running.size === 0) return;
    await withTimeout(Promise.all([...running]), ms);
  };
  return Object.assign(ended, { drain });
}

/** Whether `promise` settled before `ms` passed. */
async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), ms);
    // A hook that hangs must not keep the process alive.
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
