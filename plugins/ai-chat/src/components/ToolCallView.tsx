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

import { Button } from '@backstage/ui';
import type { ChatToolCall, ChatToolCallStatus } from '../common';
import { LinkedText } from './Markdown';
import { cx } from './styles';

const STATUS: Record<
  ChatToolCallStatus,
  { label: string; tone: 'success' | 'danger' | 'warning' | 'info' | undefined }
> = {
  pending_approval: { label: 'Waiting for approval', tone: 'warning' },
  approved: { label: 'Allowed', tone: 'info' },
  rejected: { label: 'Rejected', tone: 'danger' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export function StatusBadge({ status }: { status: ChatToolCallStatus }) {
  const { label, tone } = STATUS[status];
  return (
    <span className={cx('chat-badge', tone && `chat-tone-${tone}`)}>
      {label}
    </span>
  );
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

function isCutOutput(
  output: unknown,
): output is { truncated: true; originalLength: number; text: string } {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { truncated?: unknown }).truncated === true &&
    typeof (output as { text?: unknown }).text === 'string'
  );
}

/** The input, and the output or the error, of a call. */
export function ToolCallDetails({ toolCall }: { toolCall: ChatToolCall }) {
  const { output } = toolCall;
  return (
    <>
      <div>
        <div className={cx('chat-tool-label')}>Input</div>
        <pre className={cx('chat-code')}>{formatJson(toolCall.input)}</pre>
      </div>
      {toolCall.error && toolCall.status === 'failed' && (
        <div>
          <div className={cx('chat-tool-label')}>Error</div>
          <pre className={cx('chat-code')}>{toolCall.error}</pre>
        </div>
      )}
      {output !== undefined && (
        <div>
          <div className={cx('chat-tool-label')}>
            {isCutOutput(output)
              ? `Output (cut: the first part of ${output.originalLength} characters)`
              : 'Output'}
          </div>
          <pre className={cx('chat-code')}>
            <LinkedText
              text={isCutOutput(output) ? output.text : formatJson(output)}
            />
          </pre>
        </div>
      )}
    </>
  );
}

/** A compact row of a call that needed no decision, with its details folded. */
export function ToolCallRow({ toolCall }: { toolCall: ChatToolCall }) {
  return (
    <details className={cx('chat-tool')}>
      <summary>
        <StatusBadge status={toolCall.status} />
        <span>{toolCall.title}</span>
        <span className={cx('chat-id')}>{toolCall.actionId}</span>
      </summary>
      <div className={cx('chat-tool-body')}>
        <ToolCallDetails toolCall={toolCall} />
      </div>
    </details>
  );
}

export interface ApprovalCardProps {
  toolCall: ChatToolCall;
  /** Set while a decision is being sent. */
  disabled?: boolean;
  onApprove(toolCall: ChatToolCall): void;
  onReject(toolCall: ChatToolCall): void;
}

function decisionText(toolCall: ChatToolCall): string | undefined {
  if (toolCall.status === 'pending_approval') return undefined;
  if (toolCall.status === 'rejected' && toolCall.error === 'superseded') {
    return 'Not decided: a new message was sent, so this action did not run.';
  }
  const at = toolCall.decidedAt
    ? ` at ${new Date(toolCall.decidedAt).toLocaleString()}`
    : '';
  const who = toolCall.decidedBy ?? 'a user';
  return toolCall.status === 'rejected'
    ? `Rejected by ${who}${at}.`
    : `Allowed by ${who}${at}.`;
}

/**
 * The card for an action that is not read-only. While the call waits it
 * shows the exact input that will run and the Allow and Reject buttons; after
 * the decision it shows who decided and when.
 */
export function ApprovalCard(props: ApprovalCardProps) {
  const { toolCall, disabled } = props;
  const waiting = toolCall.status === 'pending_approval';
  const decision = decisionText(toolCall);
  return (
    <section
      className={cx('chat-approval', !waiting && 'chat-approval-decided')}
      aria-label={`Approval: ${toolCall.title}`}
    >
      <div className={cx('chat-approval-head')}>
        <span>{toolCall.title}</span>
        <span className={cx('chat-id')}>{toolCall.actionId}</span>
        {toolCall.attributes.destructive && (
          <span className={cx('chat-badge', 'chat-tone-danger')}>
            destructive
          </span>
        )}
        <StatusBadge status={toolCall.status} />
      </div>
      {toolCall.description && (
        <p className={cx('chat-approval-description')}>
          {toolCall.description}
        </p>
      )}
      {waiting ? (
        <div>
          <div className={cx('chat-tool-label')}>
            Input that will run, exactly as shown
          </div>
          <pre className={cx('chat-code')}>{formatJson(toolCall.input)}</pre>
        </div>
      ) : (
        <details>
          <summary className={cx('chat-tool-label')}>Input and result</summary>
          <div className={cx('chat-tool-body')}>
            <ToolCallDetails toolCall={toolCall} />
          </div>
        </details>
      )}
      {waiting && (
        <div className={cx('chat-approval-actions')}>
          <Button
            variant="primary"
            destructive={toolCall.attributes.destructive}
            isDisabled={disabled}
            onPress={() => props.onApprove(toolCall)}
          >
            Allow
          </Button>
          <Button
            variant="secondary"
            isDisabled={disabled}
            onPress={() => props.onReject(toolCall)}
          >
            Reject
          </Button>
        </div>
      )}
      {decision && (
        <div className={cx('chat-approval-decision')}>{decision}</div>
      )}
    </section>
  );
}
