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

import { createContext, useContext } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { Button } from '@backstage/ui';
import type { ChatTool } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { DecisionInfo } from '../domain/itemsToMessages';
import {
  NOT_RUN,
  RESULT_NOT_KNOWN,
  titleOfTool,
  type ToolStatus,
} from '../domain/toolView';
import { LinkedText } from './LinkedText';
import { cx } from './styles';

/** What a tool card reads of the call: the props of a tool component of assistant-ui. */
export type ToolCallProps = Pick<
  ToolCallMessagePartProps,
  | 'toolCallId'
  | 'toolName'
  | 'args'
  | 'result'
  | 'isError'
  | 'approval'
  | 'respondToApproval'
>;

/**
 * How the screen shows a call. A failed call carries its error text as the
 * result, so a call whose result is not known and a call that did not run
 * are told apart from a failure by that text.
 */
export function statusOfCall(
  call: Pick<ToolCallProps, 'result' | 'isError' | 'approval'>,
): ToolStatus {
  if (call.isError) {
    if (call.result === RESULT_NOT_KNOWN) return 'unknown';
    if (call.result === NOT_RUN) return 'not_run';
    return 'failed';
  }
  if (call.result !== undefined) return 'done';
  if (call.approval) {
    if (call.approval.approved === undefined) return 'waiting';
    return call.approval.approved ? 'allowed' : 'rejected';
  }
  return 'running';
}

const STATUS: Record<
  ToolStatus,
  { label: string; tone: 'success' | 'danger' | 'warning' | 'info' | undefined }
> = {
  waiting: { label: 'Waiting for approval', tone: 'warning' },
  allowed: { label: 'Allowed', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  rejected: { label: 'Denied', tone: 'danger' },
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
export function ToolCallDetails({ call }: { call: ToolCallProps }) {
  const output = call.isError ? undefined : call.result;
  return (
    <>
      <div>
        <div className={cx('chat-tool-label')}>Input</div>
        <InvisibleWarning input={call.args} />
        <pre className={cx('chat-code')}>{formatJson(call.args)}</pre>
      </div>
      {statusOfCall(call) === 'failed' && (
        <div>
          <div className={cx('chat-tool-label')}>Error</div>
          <pre className={cx('chat-code')}>{String(call.result)}</pre>
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
export function ToolCallRow({
  call,
  tool,
}: {
  call: ToolCallProps;
  tool?: ChatTool;
}) {
  const toolId = call.toolName;
  return (
    <details className={cx('chat-tool')}>
      <summary>
        <StatusBadge status={statusOfCall(call)} />
        <span>{tool?.title ?? titleOfTool(toolId)}</span>
        <span className={cx('chat-id')}>{toolId}</span>
      </summary>
      <div className={cx('chat-tool-body')}>
        <ToolCallDetails call={call} />
      </div>
    </details>
  );
}

/** Whether a call shows as a card: it waited for a decision, or got one. */
export function needsCard(call: Pick<ToolCallProps, 'approval'>): boolean {
  return Boolean(call.approval);
}

export interface ApprovalCardProps {
  call: ToolCallProps;
  /** What the session knows of the tool: its title, what it does, whether it only reads. */
  tool?: ChatTool;
  /** Who decided the call and when, when the log says. */
  decision?: DecisionInfo;
  /** Set while a decision is being sent, or a response is under way. */
  disabled?: boolean;
}

const EXPLANATION: Partial<Record<ToolStatus, string>> = {
  unknown: 'The call may have run, but its result was not stored.',
  not_run: 'The run ended before the call ran.',
};

function decisionText(
  call: ToolCallProps,
  status: ToolStatus,
  info?: DecisionInfo,
): string | undefined {
  if (status === 'waiting') return undefined;
  const approved = call.approval?.approved;
  let decision: string | undefined;
  if (approved !== undefined) {
    const word = approved ? 'Allowed' : 'Denied';
    decision = info
      ? `${word} by ${info.by} at ${new Date(info.at).toLocaleString()}.`
      : `${word}.`;
  }
  return [decision, EXPLANATION[status]].filter(Boolean).join(' ') || undefined;
}

/** Why the call asks, when the tool is known. */
function whyAsks(tool?: ChatTool): string | undefined {
  if (!tool) return undefined;
  return tool.readOnly
    ? 'The policy of your administrator asks for your approval before this action runs.'
    : 'This action changes something. It runs only after you approve it.';
}

/**
 * The card for an action that is not read-only. While the call waits it
 * shows the exact input that will run and the Allow and Deny buttons; after
 * the decision it shows what was decided.
 */
export function ApprovalCard(props: ApprovalCardProps) {
  const { call, disabled } = props;
  const status = statusOfCall(call);
  const toolId = call.toolName;
  const title = props.tool?.title ?? titleOfTool(toolId);
  const waiting = status === 'waiting';
  const decision = decisionText(call, status, props.decision);
  // A decision that the runtime refuses (the call is decided already) leaves
  // the card as the next state of the messages shows it.
  const decide = (approved: boolean) =>
    Promise.resolve()
      .then(() => call.respondToApproval({ approved }))
      .catch(() => undefined);
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
      {props.tool?.description && (
        <p className={cx('chat-approval-description')}>
          {props.tool.description}
        </p>
      )}
      {waiting && whyAsks(props.tool) && (
        <p className={cx('chat-approval-description')}>{whyAsks(props.tool)}</p>
      )}
      {waiting ? (
        <div>
          <div className={cx('chat-tool-label')}>
            Input that will run, exactly as shown
          </div>
          <InvisibleWarning input={call.args} />
          <pre className={cx('chat-code')}>{formatJson(call.args)}</pre>
        </div>
      ) : (
        <details>
          <summary className={cx('chat-tool-label')}>Input and result</summary>
          <div className={cx('chat-tool-body')}>
            <ToolCallDetails call={call} />
          </div>
        </details>
      )}
      {waiting && (
        <div className={cx('chat-approval-actions')}>
          <Button
            variant="primary"
            isDisabled={disabled}
            onPress={() => decide(true)}
          >
            Allow
          </Button>
          <Button
            variant="secondary"
            isDisabled={disabled}
            onPress={() => decide(false)}
          >
            Deny
          </Button>
        </div>
      )}
      {decision && (
        <div className={cx('chat-approval-decision')}>{decision}</div>
      )}
    </section>
  );
}

/** What the session knows around the calls: the tools, who decided, and whether a card can be used now. */
export interface ToolCallView {
  /** The tools of the session by id. */
  tools?: Record<string, ChatTool>;
  /** Who decided which call, and when, when the log says. */
  decisions?: Record<string, DecisionInfo>;
  /** Set while a decision is being sent, or a response is under way. */
  disabled: boolean;
}

export const ToolCallViewContext = createContext<ToolCallView>({
  disabled: false,
});

/**
 * The tool component of the message parts: a card for a call that waited
 * for a decision or got one, a compact row for the others.
 */
export function ToolCall(props: ToolCallMessagePartProps) {
  const view = useContext(ToolCallViewContext);
  const tool = view.tools?.[props.toolName];
  return needsCard(props) ? (
    <ApprovalCard
      call={props}
      tool={tool}
      decision={view.decisions?.[props.toolCallId]}
      disabled={view.disabled}
    />
  ) : (
    <ToolCallRow call={props} tool={tool} />
  );
}
