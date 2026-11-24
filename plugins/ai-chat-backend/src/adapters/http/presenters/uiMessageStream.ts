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

import { messageIdOfRun } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type {
  ChatRunStatus,
  ChatNoticeData,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type {
  HarnessEvent,
  Item,
  RunOutcome,
  ToolCallItem,
} from '@kwkevinchan/ai-chat-harness';
import type { UiMessageChunk } from './uiMessageChunk';

const NOTICES: Record<ChatNoticeData['code'], ChatNoticeData> = {
  summarizing: {
    code: 'summarizing',
    text: 'Summarizing the earlier part of the conversation.',
  },
  context_trimmed: {
    code: 'context_trimmed',
    text: 'Earlier content was left out.',
  },
};

const STOPPED_TEXT = 'The run stopped.';

/**
 * Turns the events of a run into the chunks of the AI SDK UI message stream
 * (architecture, "HTTP": the table of events). One presenter makes one
 * response; it keeps what it has sent (the open text parts, the open step).
 *
 * - `tool_call` is shown when its item is complete (`item.started` of a
 *   `tool_call` is ignored): the input is not known before.
 * - The text of an `agent_message` goes out as `text-start`, `text-delta` and
 *   `text-end`. An item that arrives complete (no draft was seen) goes out as
 *   a start, one delta with the whole text and an end.
 * - The error of a failed run is the fixed text of the outcome. The cause of
 *   the failure never reaches a chunk.
 * - `summary` and `note` items are not messages: only `data-item` shows
 *   them. `summary.started` and the two events that say content was left out
 *   become `data-notice`; the second one is sent once per stream.
 * - Every item gets a transient `data-item` with its `seq`. An item whose
 *   `seq` the presenter has sent already (a replayed item that comes again
 *   as an event) is skipped.
 */
export class UiMessageStreamPresenter {
  private stepOpen = false;
  private readonly openText = new Map<string, string>();
  private lastSeq = 0;
  private trimmedSent = false;
  private ended = false;
  private replaying = false;

  /**
   * `afterStart` goes out right after `start`: the decisions of the request
   * that a stream after an approval begins with. `typing` false drops the
   * pieces of text that arrive while an item is written: a client that joined
   * in the middle gets each text whole, when it is complete.
   */
  constructor(
    private readonly options: {
      runId: string;
      afterStart?: UiMessageChunk[];
      typing?: boolean;
    },
  ) {}

  /** The chunks of one event. */
  present(event: HarnessEvent): UiMessageChunk[] {
    switch (event.type) {
      case 'run.started':
        return [
          this.start(),
          ...(this.options.afterStart ?? []),
          this.run('running'),
        ];
      case 'step.started':
        return [...this.closeStep(), ...this.openStep()];
      case 'step.ended':
        return this.closeStep();
      case 'item.started':
        if (event.kind !== 'agent_message' || this.options.typing === false) {
          return [];
        }
        this.openText.set(event.draftId, '');
        return [{ type: 'text-start', id: event.draftId }];
      case 'item.delta': {
        const sent = this.openText.get(event.draftId);
        if (sent === undefined) return [];
        this.openText.set(event.draftId, sent + event.text);
        return [{ type: 'text-delta', id: event.draftId, delta: event.text }];
      }
      case 'item.completed':
        return this.item(event.item, event.draftId);
      case 'summary.started':
        return [
          { type: 'data-notice', data: NOTICES.summarizing, transient: true },
        ];
      case 'summary.failed':
      case 'context.trimmed':
        return this.trimmedNotice();
      case 'run.ended':
        return this.end(event.outcome);
      default:
        return event satisfies never;
    }
  }

  /**
   * The chunks of a client that joins a run that is under way: `start`, the
   * state of the run, and the items of the run so far, in the order of
   * `seq` (A-07). Events of items up to `upToSeq` (the highest `seq` that was
   * read, also of items left out) are skipped when they come.
   */
  replay(
    status: ChatRunStatus,
    items: readonly Item[],
    upToSeq: number,
  ): UiMessageChunk[] {
    this.replaying = true;
    const chunks: UiMessageChunk[] = [this.start(), this.run(status)];
    for (const item of items) chunks.push(...this.item(item));
    this.replaying = false;
    this.lastSeq = Math.max(this.lastSeq, upToSeq);
    return chunks;
  }

  /**
   * The chunks to send when the events end. A run that ended has sent its own
   * end already; one whose events stop without `run.ended` is reported as
   * stopped, so the client does not wait for more.
   */
  close(): UiMessageChunk[] {
    if (this.ended) return [];
    return this.end({ status: 'failed', message: STOPPED_TEXT });
  }

  private start(): UiMessageChunk {
    return { type: 'start', messageId: messageIdOfRun(this.options.runId) };
  }

  private run(status: ChatRunStatus, endReason?: string): UiMessageChunk {
    return {
      type: 'data-run',
      data: {
        runId: this.options.runId,
        status,
        ...(endReason !== undefined && { endReason }),
      },
      transient: true,
    };
  }

  private openStep(): UiMessageChunk[] {
    if (this.stepOpen) return [];
    this.stepOpen = true;
    return [{ type: 'start-step' }];
  }

  private closeStep(): UiMessageChunk[] {
    if (!this.stepOpen) return [];
    this.stepOpen = false;
    return [{ type: 'finish-step' }];
  }

  private trimmedNotice(): UiMessageChunk[] {
    if (this.trimmedSent) return [];
    this.trimmedSent = true;
    return [
      { type: 'data-notice', data: NOTICES.context_trimmed, transient: true },
    ];
  }

  private item(item: Item, draftId?: string): UiMessageChunk[] {
    if (item.seq <= this.lastSeq) {
      return draftId === undefined ? [] : this.closeText(draftId);
    }
    this.lastSeq = item.seq;
    const chunks = this.chunksOf(item, draftId);
    chunks.push({
      type: 'data-item',
      data: { seq: item.seq, kind: item.kind },
      transient: true,
    });
    return chunks;
  }

  private chunksOf(item: Item, draftId?: string): UiMessageChunk[] {
    switch (item.kind) {
      case 'agent_message':
        return [...this.openStep(), ...this.text(item.seq, item.text, draftId)];
      case 'tool_call':
        return [
          ...this.openStep(),
          {
            type: 'tool-input-available',
            toolCallId: item.callId,
            toolName: item.toolId,
            input: item.input,
          },
        ];
      case 'approval':
        return [
          ...this.stepEnd(),
          {
            type: 'tool-approval-response',
            approvalId: item.callId,
            approved: item.decision === 'allow',
          },
        ];
      case 'tool_started':
        return this.stepEnd();
      case 'tool_result':
        return [...this.stepEnd(), toolOutput(item)];
      case 'plan_update':
        return [{ type: 'data-plan', id: 'plan', data: item.plan }];
      default:
        // user_message, summary and note are not part of the assistant message.
        return [];
    }
  }

  /** Items that follow a step (decisions, results) close the step of a replay. */
  private stepEnd(): UiMessageChunk[] {
    return this.replaying ? this.closeStep() : [];
  }

  /** The text of a complete `agent_message`: what is not sent yet, then the end. */
  private text(seq: number, text: string, draftId?: string): UiMessageChunk[] {
    const id = draftId ?? `text_${seq}`;
    const chunks: UiMessageChunk[] = [];
    let sent = this.openText.get(id);
    if (sent === undefined) {
      chunks.push({ type: 'text-start', id });
      sent = '';
    }
    if (text.length > sent.length && text.startsWith(sent)) {
      chunks.push({ type: 'text-delta', id, delta: text.slice(sent.length) });
    }
    this.openText.delete(id);
    chunks.push({ type: 'text-end', id });
    return chunks;
  }

  private closeText(id: string): UiMessageChunk[] {
    if (!this.openText.delete(id)) return [];
    return [{ type: 'text-end', id }];
  }

  private end(outcome: RunOutcome): UiMessageChunk[] {
    this.ended = true;
    const chunks: UiMessageChunk[] = [
      ...[...this.openText.keys()].flatMap(id => this.closeText(id)),
      ...this.closeStep(),
    ];
    switch (outcome.status) {
      case 'waiting_approval':
        chunks.push(
          ...outcome.pending.map(approvalRequest),
          this.run('waiting_approval'),
          { type: 'finish', finishReason: 'tool-calls' },
        );
        break;
      case 'completed':
        chunks.push(this.run('completed', outcome.endReason), {
          type: 'finish',
          finishReason: 'stop',
        });
        break;
      case 'failed':
        // `useChat` stops reading at `error`: the state comes first, and no
        // `finish` follows.
        chunks.push(this.run('failed'), {
          type: 'error',
          errorText: outcome.message,
        });
        break;
      case 'cancelled':
        chunks.push(this.run('cancelled'), { type: 'abort' });
        break;
      default:
        return outcome satisfies never;
    }
    return chunks;
  }
}

function approvalRequest(call: ToolCallItem): UiMessageChunk {
  return {
    type: 'tool-approval-request',
    approvalId: call.callId,
    toolCallId: call.callId,
    reason: call.readOnly
      ? 'The policy asks for approval.'
      : 'The action is not read-only.',
  };
}

function toolOutput(item: Item & { kind: 'tool_result' }): UiMessageChunk {
  const toolCallId = item.callId;
  switch (item.status) {
    case 'ok':
      return {
        type: 'tool-output-available',
        toolCallId,
        output: item.output ?? null,
      };
    case 'denied':
      return { type: 'tool-output-denied', toolCallId };
    case 'timeout':
      return {
        type: 'tool-output-error',
        toolCallId,
        errorText: item.message ?? 'The tool call timed out.',
      };
    case 'invalid':
      return {
        type: 'tool-output-error',
        toolCallId,
        errorText: item.message ?? 'The input of the tool call is not valid.',
      };
    case 'unknown':
      return {
        type: 'tool-output-error',
        toolCallId,
        errorText: item.message ?? 'The result of the tool call is not known.',
      };
    default:
      return {
        type: 'tool-output-error',
        toolCallId,
        errorText: item.message ?? 'The tool call failed.',
      };
  }
}
