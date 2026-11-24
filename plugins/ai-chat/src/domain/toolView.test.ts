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

import { TOOL_RESULT_NOT_KNOWN } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { NOT_RUN, statusOfTool } from './toolView';
import type { ToolPart } from './types';

const errored = (errorText: string) =>
  ({
    type: 'tool-x:y',
    toolCallId: 'c',
    state: 'output-error',
    input: {},
    errorText,
  } as unknown as ToolPart);

describe('statusOfTool', () => {
  it('shows the mark of the stream for a result that is not known as such, as the restored one', () => {
    expect(statusOfTool(errored(TOOL_RESULT_NOT_KNOWN))).toBe('unknown');
  });

  it('tells a call that did not run, and a failure, apart', () => {
    expect(statusOfTool(errored(NOT_RUN))).toBe('not_run');
    expect(statusOfTool(errored('boom'))).toBe('failed');
  });
});
