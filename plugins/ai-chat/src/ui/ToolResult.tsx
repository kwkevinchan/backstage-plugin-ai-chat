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

import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import type { AiChatToolResultsApi } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { isBuiltInTool, resultStatusOf } from '../domain/toolResults';
import { cx } from './styles';
import { statusOfCall } from './ToolCallCard';

/**
 * Shows nothing when the result component of a plugin throws while it
 * renders: the row or the card of the call above it is the default view, and
 * the rest of the conversation stays.
 */
class ToolResultBoundary extends Component<
  { actionId: string; children: ReactNode },
  { failed: boolean }
> {
  static getDerivedStateFromError() {
    return { failed: true };
  }

  state = { failed: false };

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.warn(
      `ai-chat: the result component for ${this.props.actionId} failed; the default view is shown.`,
      error,
      info.componentStack,
    );
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The result component that a plugin registered for the action of this call,
 * under the row or the card of the call. Nothing for a tool of the core, an
 * action without a component, a call that waits for a decision and a call
 * that did not run.
 */
export function ToolResult({
  call,
  title,
  toolResults,
}: {
  call: Pick<
    ToolCallMessagePartProps,
    'toolName' | 'args' | 'result' | 'isError' | 'approval'
  >;
  title: string;
  toolResults?: AiChatToolResultsApi;
}) {
  const actionId = call.toolName;
  if (isBuiltInTool(actionId)) return null;
  const Result = toolResults?.getComponent(actionId);
  const status = resultStatusOf(statusOfCall(call));
  if (!Result || !status) return null;
  return (
    // A new status is a new try for a component that failed before.
    <ToolResultBoundary key={status} actionId={actionId}>
      <div
        className={cx('chat-tool-result')}
        role="group"
        aria-label={`Result: ${title}`}
      >
        <Result
          actionId={actionId}
          input={call.args}
          status={status}
          output={status === 'complete' ? call.result : undefined}
          errorText={
            status === 'failed' || status === 'unknown'
              ? String(call.result)
              : undefined
          }
        />
      </div>
    </ToolResultBoundary>
  );
}
