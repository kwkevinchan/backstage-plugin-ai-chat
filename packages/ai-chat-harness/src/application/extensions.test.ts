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

import type { ToolResult } from './ports/extensions';
import type { ModelClient } from './ports/ModelClient';
import { say } from '../testing';
import { kit } from '../testing/fixture';

/**
 * P3-01 stores the registrations on the loop and does not call them.
 * Context, skills, hooks and a registered model client come later
 * (P3-02, P3-04, P3-05, P3-07).
 */
describe('AdvanceRun extensions', () => {
  it('does not call context providers, skills, hooks or a registered model client', async () => {
    const provide = jest.fn(async () => 'from the provider');
    const load = jest.fn(async () => 'the whole skill');
    const beforeModelCall = jest.fn(async () => {});
    const beforeToolCall = jest.fn(async () => ({
      action: 'continue' as const,
    }));
    const afterToolCall = jest.fn(
      async (_call: unknown, result: ToolResult) => result,
    );
    const onRunEnd = jest.fn(async () => {});
    const stream = jest.fn();
    const registered: ModelClient = {
      capabilities: { parallelToolCalls: false, images: false },
      async *stream() {
        stream();
        yield { type: 'text', text: 'from the registered client' };
      },
    };

    const t = await kit({
      script: [[say('Hello')]],
      extensions: {
        contextProviders: [{ id: 'site', provide }],
        skills: [
          {
            id: 'getting-started',
            description: 'How to start',
            load,
          },
        ],
        hooks: {
          beforeModelCall: [beforeModelCall],
          beforeToolCall: [beforeToolCall],
          afterToolCall: [afterToolCall],
          onRunEnd: [onRunEnd],
        },
        modelClients: new Map([['other', registered]]),
      },
    });

    const { outcome } = await t.execute();

    expect(outcome).toEqual({ status: 'completed' });
    expect(provide).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(beforeModelCall).not.toHaveBeenCalled();
    expect(beforeToolCall).not.toHaveBeenCalled();
    expect(afterToolCall).not.toHaveBeenCalled();
    expect(onRunEnd).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(t.model.inputs).toHaveLength(1);
  });
});
