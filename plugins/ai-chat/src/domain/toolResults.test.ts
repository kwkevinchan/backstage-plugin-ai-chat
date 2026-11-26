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

import { isBuiltInTool, resultStatusOf } from './toolResults';

describe('resultStatusOf', () => {
  it('maps the status of a call to the status of a result component', () => {
    expect(resultStatusOf('running')).toBe('running');
    expect(resultStatusOf('allowed')).toBe('running');
    expect(resultStatusOf('done')).toBe('complete');
    expect(resultStatusOf('failed')).toBe('failed');
    expect(resultStatusOf('rejected')).toBe('denied');
    expect(resultStatusOf('unknown')).toBe('unknown');
  });

  it('gives no status to a call that waits for a decision or did not run', () => {
    expect(resultStatusOf('waiting')).toBeUndefined();
    expect(resultStatusOf('not_run')).toBeUndefined();
  });
});

describe('isBuiltInTool', () => {
  it('knows the tools of the core', () => {
    expect(isBuiltInTool('update_plan')).toBe(true);
    expect(isBuiltInTool('load_skill')).toBe(true);
    expect(isBuiltInTool('dev-actions:list-services')).toBe(false);
  });
});
