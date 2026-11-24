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

import {
  messageIdOfRun,
  TOOL_RESULT_NOT_KNOWN,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type {
  ChatRunStatus,
  ChatNoticeData,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type {
  Item,
  RunOutcome,
  ToolCallItem,
} from '@kwkevinchan/ai-chat-harness';
import type { HostEvent } from '../../../application';
import { toChatQueuedMessage } from './session';
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
 * - An inserted message the model read goes out as `data-inserted`, before the
 *   step that read it. It is no item of the stream: the message was written
 *   when the user inserted it, so its `seq` is lower than that of the output
 *   before it and the `seq` check above would drop it. The presenter keeps the
 *   `seq` of the inserted messages it sent instead, and sends each once; a
 *   replay marks the ones it sent, so the live event does not send them again.
 * - The state of the queue goes out as a transient `data-queue`, before the
 *   `data-run` of the end.
 */
export class UiMessageStreamPresenter {
  private stepOpen = false;
  private readonly openText = new Map<string, string>();
  private lastSeq = 0;
  /** The `seq` of the inserted messages already sent as `data-inserted`. */
  private readonly insertedSent = new Set<number>();
  /**
   * Inserted messages the model read already (their `message.read` came before
   * this stream began) and that the stream has not sent: the output that read
   * them has not been written yet, or the replay left it out. The first output
   * of the live stream that read them sends them.
   */
  private waiting: Item[] = [];
  private trimmedSent = false;
  private ended = false;
  private replaying = false;
  /** The calls shown so far, to ask for the approval of one before its decision. */
  private readonly calls = new Map<string, ToolCallItem>();
  /** The steps up to this number were replayed: their step events are skipped. */
  private replayedStep = 0;
  /** The steps that the replay opened, one for each step of the run that has an item. */
  private replayedSteps = 0;

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
  present(event: HostEvent): UiMessageChunk[] {
    switch (event.type) {
      case 'run.started':
        return [
          this.start(),
          ...(this.options.afterStart ?? []),
          this.run('running'),
        ];
      case 'message.read':
        return event.item.kind === 'user_message'
          ? this.inserted(event.item)
          : [];
      case 'queue.state':
        return [
          {
            type: 'data-queue',
            data: {
              items: event.items.map(toChatQueuedMessage),
              paused: event.paused,
              ...(event.pausedReason !== undefined && {
                pausedReason: event.pausedReason,
              }),
              ...(event.nextRunId !== undefined && {
                nextRunId: event.nextRunId,
              }),
            },
            transient: true,
          },
        ];
      case 'step.started':
        if (event.step <= this.replayedStep) return [];
        return [...this.closeStep(), ...this.openStep()];
      case 'step.ended':
        if (event.step <= this.replayedStep) return [];
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
   *
   * `inserted` is every inserted message of the run that no output of `items`
   * before the first one shown read: also those that `items` leaves out. Each
   * goes out before the output that read it, in the replay or, when no output
   * read it yet, in the live stream with the first output that did.
   */
  replay(
    status: ChatRunStatus,
    items: readonly Item[],
    upToSeq: number,
    inserted: readonly Item[] = [],
  ): UiMessageChunk[] {
    this.replaying = true;
    const chunks: UiMessageChunk[] = [this.start(), this.run(status)];
    const known = new Map<number, Item>();
    for (const item of [...inserted, ...items]) {
      if (item.kind === 'user_message' && item.delivery === 'inserted') {
        known.set(item.seq, item);
      }
    }
    this.waiting = [...known.values()]
      .filter(message => !this.insertedSent.has(message.seq))
      .sort((a, b) => a.seq - b.seq);
    for (const item of items) chunks.push(...this.item(item));
    this.replaying = false;
    this.lastSeq = Math.max(this.lastSeq, upToSeq);
    // A step that wrote a call has its number in the call. A step that wrote
    // only an `agent_message` has no number in the log: the steps of a run
    // come one after the other, so the count of the steps opened stands for it.
    this.replayedStep = [...this.calls.values()].reduce(
      (max, call) => Math.max(max, call.step),
      this.replayedSteps,
    );
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
    if (this.replaying) this.replayedSteps += 1;
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

  private inserted(message: Item): UiMessageChunk[] {
    if (message.kind !== 'user_message') return [];
    this.waiting = this.waiting.filter(m => m.seq !== message.seq);
    if (this.insertedSent.has(message.seq)) return [];
    this.insertedSent.add(message.seq);
    return [
      {
        type: 'data-inserted',
        id: `inserted-${message.seq}`,
        data: {
          seq: message.seq,
          text: message.text,
          ...(message.page && { page: message.page }),
        },
      },
    ];
  }

  /**
   * The waiting inserted messages that `output` read (its `readUpToSeq`, or
   * its own `seq` for an output with no mark). In a replay the step that is
   * open ends first, so they come before the step that read them.
   */
  private takeRead(output: Item): UiMessageChunk[] {
    if (output.kind !== 'agent_message' && output.kind !== 'tool_call') {
      return [];
    }
    const mark = output.readUpToSeq ?? output.seq;
    const read = this.waiting.filter(message => message.seq <= mark);
    if (read.length === 0) return [];
    const chunks = read.flatMap(message => this.inserted(message));
    return chunks.length > 0 && this.replaying
      ? [...this.closeStep(), ...chunks]
      : chunks;
  }

  private item(item: Item, draftId?: string): UiMessageChunk[] {
    if (item.seq <= this.lastSeq) {
      return draftId === undefined ? [] : this.closeText(draftId);
    }
    this.lastSeq = item.seq;
    const chunks = [...this.takeRead(item), ...this.chunksOf(item, draftId)];
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
        this.calls.set(item.callId, item);
        return [
          ...this.openStep(),
          {
            type: 'tool-input-available',
            toolCallId: item.callId,
            toolName: item.toolId,
            input: item.input,
          },
        ];
      case 'approval': {
        // The SDK finds the part of a decision by the request of the approval,
        // so a stream that did not carry the request (a replay) sends it first.
        const call = this.calls.get(item.callId);
        return [
          ...this.stepEnd(),
          ...(call ? [approvalRequest(call)] : []),
          {
            type: 'tool-approval-response',
            approvalId: item.callId,
            approved: item.decision === 'allow',
          },
        ];
      }
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
        errorText: TOOL_RESULT_NOT_KNOWN,
      };
    default:
      return {
        type: 'tool-output-error',
        toolCallId,
        errorText: item.message ?? 'The tool call failed.',
      };
  }
}
