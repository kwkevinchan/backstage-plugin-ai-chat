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

import { createAiChatToolResultsApi } from './toolResultsApi';

const First = () => null;
const Second = () => null;

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('createAiChatToolResultsApi', () => {
  it('finds the component of an action id, and nothing for another id', () => {
    const api = createAiChatToolResultsApi([
      { actionId: 'example:list', component: First },
    ]);
    expect(api.getComponent('example:list')).toBe(First);
    expect(api.getComponent('example:other')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the first component of an action id and warns about the later one', () => {
    const api = createAiChatToolResultsApi([
      { actionId: 'example:list', component: First },
      { actionId: 'example:list', component: Second },
    ]);
    expect(api.getComponent('example:list')).toBe(First);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'ai-chat: a result component for example:list is registered already; the later one is not used.',
    );
  });

  it.each(['update_plan', 'load_skill'])(
    'does not use a component for the tool %s of the core, and warns',
    toolId => {
      const api = createAiChatToolResultsApi([
        { actionId: toolId, component: First },
      ]);
      expect(api.getComponent(toolId)).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`${toolId} is a tool of the chat`),
      );
    },
  );

  it('leaves out a registration without an action id or a component', () => {
    const api = createAiChatToolResultsApi([
      { actionId: '', component: First },
      { actionId: 'example:list', component: undefined as never },
    ]);
    expect(api.getComponent('')).toBeUndefined();
    expect(api.getComponent('example:list')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
