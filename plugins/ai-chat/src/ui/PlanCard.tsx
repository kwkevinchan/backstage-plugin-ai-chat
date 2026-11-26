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

import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import type {
  ChatPlan,
  ChatPlanItemStatus,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { completedCount, planOfInput } from '../domain/plan';
import { cx } from './styles';
import { statusOfCall, ToolCall } from './ToolCallCard';

const STEP: Record<
  ChatPlanItemStatus,
  { mark: string; label: string; tone?: 'success' | 'info' }
> = {
  pending: { mark: '○', label: 'To do' },
  in_progress: { mark: '→', label: 'In progress', tone: 'info' },
  completed: { mark: '✓', label: 'Done', tone: 'success' },
};

/** A plan as a checklist: each step with its text and its status in words. */
export function PlanList({ plan }: { plan: ChatPlan }) {
  const total = plan.items.length;
  return (
    <section className={cx('chat-plan')} aria-label="Plan">
      <div className={cx('chat-plan-head')}>
        <span>Plan</span>
        <span className={cx('chat-plan-count')}>
          {total === 0
            ? 'No steps'
            : `${completedCount(plan)} of ${total} done`}
        </span>
      </div>
      {total > 0 && (
        <ol className={cx('chat-plan-list')}>
          {plan.items.map((item, index) => {
            const step = STEP[item.status];
            return (
              <li
                // The steps of one plan never move: the next update is a new list.
                key={index}
                className={cx(
                  'chat-plan-item',
                  item.status === 'completed' && 'chat-plan-item-completed',
                )}
              >
                <span className={cx('chat-plan-mark')} aria-hidden="true">
                  {step.mark}
                </span>
                <span className={cx('chat-plan-text')}>{item.text}</span>
                <span
                  className={cx(
                    'chat-badge',
                    step.tone && `chat-tone-${step.tone}`,
                  )}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * The tool component of `update_plan`: the plan of the call as a checklist.
 * A call that waits for a decision, failed, was refused, or has no plan in its
 * input is shown as any other call, so its state and its error stay visible.
 */
export function PlanToolCall(props: ToolCallMessagePartProps) {
  const plan = planOfInput(props.args);
  const status = statusOfCall(props);
  const shown =
    plan !== undefined &&
    (status === 'done' || (status === 'running' && !props.approval));
  return shown ? <PlanList plan={plan} /> : <ToolCall {...props} />;
}
