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

import { buildSummaryInput, type Item, type SummaryPlan } from '../../domain';
import type { HarnessEvent } from '../events';
import type { AdvanceRunDeps, AdvanceRunRequest } from '../types';

/**
 * How the summary step ended: the `summary` item is written (`written`, with
 * the item), the model call failed or gave no text (`failed`, nothing is
 * written), or the signal aborted (`aborted`, nothing is written).
 */
export type SummarizeResult =
  | { status: 'written'; item: Item }
  | { status: 'failed' }
  | { status: 'aborted' };

/**
 * The longest summary that is written, in characters. A model that does not
 * keep to the length would otherwise make every step need a new summary.
 */
export const SUMMARY_MAX_CHARS = 4000;

/**
 * Makes the summary of the old steps in `plan` with a model call (H-09) and
 * writes it as a `summary` item: a new item at the end of the log, so the
 * items it covers stay as they are (A-05).
 *
 * The call uses the model of the run with no tools, the signal of the run (so
 * the deadline ends it) and the same budget as the steps. A failure of the
 * call, or an answer with no text, does not fail the run: the step reports
 * `summary.failed`, and the caller goes on without a summary. An abort ends
 * the step without a trace in the log. Errors of the log (`LeaseLost`) are
 * thrown, as everywhere in the loop.
 */
export async function* summarize(
  deps: AdvanceRunDeps,
  req: AdvanceRunRequest,
  plan: SummaryPlan,
): AsyncGenerator<HarnessEvent, SummarizeResult> {
  yield { type: 'summary.started', coversUpToSeq: plan.coversUpToSeq };

  let text = '';
  try {
    for await (const chunk of req.model.stream(
      buildSummaryInput(plan, req.budget),
      { signal: req.signal, sessionId: req.ctx.sessionId },
    )) {
      // The request offers no tools, so a call in the answer is ignored.
      if (chunk.type === 'text') text += chunk.text;
    }
  } catch (error) {
    if (req.signal.aborted) return { status: 'aborted' };
    yield { type: 'summary.failed', cause: error };
    return { status: 'failed' };
  }
  if (req.signal.aborted) return { status: 'aborted' };

  const summary = text.trim().slice(0, SUMMARY_MAX_CHARS);
  if (summary.length === 0) {
    yield { type: 'summary.failed' };
    return { status: 'failed' };
  }

  const [item] = await deps.items.append(
    req.ctx.sessionId,
    [{ kind: 'summary', coversUpToSeq: plan.coversUpToSeq, text: summary }],
    req.fence,
  );
  yield { type: 'item.completed', item };
  return { status: 'written', item };
}
