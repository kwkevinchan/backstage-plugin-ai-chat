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
import {
  statusOfTool,
  titleOfTool,
  toolIdOf,
  type ToolStatus,
} from '../domain/toolView';
import type { ToolPart } from '../domain/types';
import { LinkedText } from './Markdown';
import { cx } from './styles';

const STATUS: Record<
  ToolStatus,
  { label: string; tone: 'success' | 'danger' | 'warning' | 'info' | undefined }
> = {
  waiting: { label: 'Waiting for approval', tone: 'warning' },
  allowed: { label: 'Allowed', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'danger' },
  unknown: { label: 'Result unknown', tone: 'warning' },
  not_run: { label: 'Did not run', tone: undefined },
};

export function StatusBadge({ status }: { status: ToolStatus }) {
  const { label, tone } = STATUS[status];
  return (
    <span className={cx('chat-badge', tone && `chat-tone-${tone}`)}>
      {label}
    </span>
  );
}

// Format characters (zero width, direction marks), control characters, the
// line and paragraph separators and the Hangul filler characters look like
// nothing or like a space; a person who reads the card must see them.
const INVISIBLE = /[\p{Cf}\p{Cc}\u2028\u2029\u115F\u1160\u3164\uFFA0]/u;
const INVISIBLE_ALL = /[\p{Cf}\p{Cc}\u2028\u2029\u115F\u1160\u3164\uFFA0]/gu;

function escapeInvisible(text: string): string {
  return text.replace(INVISIBLE_ALL, char => {
    if (char === '\n') return char;
    const code = char.codePointAt(0)!;
    return code > 0xffff
      ? `\\u{${code.toString(16).toUpperCase()}}`
      : `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

/** JSON text for the card, with invisible characters written as \uXXXX. */
export function formatJson(value: unknown): string {
  return escapeInvisible(JSON.stringify(value, null, 2) ?? 'null');
}

/** Whether a key or a string in `value` has an invisible character. */
export function hasInvisibleCharacters(value: unknown): boolean {
  if (typeof value === 'string')
    return INVISIBLE.test(value.replace(/\n/g, ''));
  if (Array.isArray(value)) return value.some(hasInvisibleCharacters);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, item]) =>
        hasInvisibleCharacters(key) || hasInvisibleCharacters(item),
    );
  }
  return false;
}

function InvisibleWarning({ input }: { input: unknown }) {
  if (!hasInvisibleCharacters(input)) return null;
  return (
    <div className={cx('chat-warning')} role="alert">
      The input has invisible characters. They are shown as \uXXXX below.
    </div>
  );
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
export function ToolCallDetails({ part }: { part: ToolPart }) {
  const output = part.state === 'output-available' ? part.output : undefined;
  return (
    <>
      <div>
        <div className={cx('chat-tool-label')}>Input</div>
        <InvisibleWarning input={part.input} />
        <pre className={cx('chat-code')}>{formatJson(part.input)}</pre>
      </div>
      {part.state === 'output-error' && statusOfTool(part) === 'failed' && (
        <div>
          <div className={cx('chat-tool-label')}>Error</div>
          <pre className={cx('chat-code')}>{part.errorText}</pre>
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
export function ToolCallRow({ part }: { part: ToolPart }) {
  const toolId = toolIdOf(part);
  return (
    <details className={cx('chat-tool')}>
      <summary>
        <StatusBadge status={statusOfTool(part)} />
        <span>{titleOfTool(toolId)}</span>
        <span className={cx('chat-id')}>{toolId}</span>
      </summary>
      <div className={cx('chat-tool-body')}>
        <ToolCallDetails part={part} />
      </div>
    </details>
  );
}

/** Whether a call shows as a card: it waited for a decision, or got one. */
export function needsCard(part: ToolPart): boolean {
  return (
    part.state === 'approval-requested' ||
    part.state === 'approval-responded' ||
    part.state === 'output-denied' ||
    Boolean(part.approval)
  );
}

export interface ApprovalCardProps {
  part: ToolPart;
  /** Set while a decision is being sent, or a response is under way. */
  disabled?: boolean;
  onDecide(callId: string, approved: boolean): void;
}

const EXPLANATION: Partial<Record<ToolStatus, string>> = {
  unknown: 'The call may have run, but its result was not stored.',
  not_run: 'The run ended before the call ran.',
};

function decisionText(part: ToolPart, status: ToolStatus): string | undefined {
  if (status === 'waiting') return undefined;
  const approved = part.approval?.approved;
  let decision: string | undefined;
  if (approved === true) decision = 'Allowed.';
  if (approved === false) decision = 'Rejected.';
  return [decision, EXPLANATION[status]].filter(Boolean).join(' ') || undefined;
}

/**
 * The card for an action that is not read-only. While the call waits it
 * shows the exact input that will run and the Allow and Reject buttons; after
 * the decision it shows what was decided.
 */
export function ApprovalCard(props: ApprovalCardProps) {
  const { part, disabled } = props;
  const status = statusOfTool(part);
  const toolId = toolIdOf(part);
  const title = titleOfTool(toolId);
  const waiting = status === 'waiting';
  const decision = decisionText(part, status);
  return (
    <section
      className={cx('chat-approval', !waiting && 'chat-approval-decided')}
      aria-label={`Approval: ${title}`}
    >
      <div className={cx('chat-approval-head')}>
        <span>{title}</span>
        <span className={cx('chat-id')}>{toolId}</span>
        <StatusBadge status={status} />
      </div>
      {waiting ? (
        <div>
          <div className={cx('chat-tool-label')}>
            Input that will run, exactly as shown
          </div>
          <InvisibleWarning input={part.input} />
          <pre className={cx('chat-code')}>{formatJson(part.input)}</pre>
        </div>
      ) : (
        <details>
          <summary className={cx('chat-tool-label')}>Input and result</summary>
          <div className={cx('chat-tool-body')}>
            <ToolCallDetails part={part} />
          </div>
        </details>
      )}
      {waiting && (
        <div className={cx('chat-approval-actions')}>
          <Button
            variant="primary"
            isDisabled={disabled}
            onPress={() => props.onDecide(part.toolCallId, true)}
          >
            Allow
          </Button>
          <Button
            variant="secondary"
            isDisabled={disabled}
            onPress={() => props.onDecide(part.toolCallId, false)}
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
