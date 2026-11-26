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

import { createExtensionTester } from '@backstage/frontend-test-utils';
import { AiChatToolResultBlueprint } from './alpha';

function Result() {
  return null;
}

describe('AiChatToolResultBlueprint', () => {
  it('outputs the action id and the component', () => {
    const extension = AiChatToolResultBlueprint.make({
      name: 'list-services',
      params: { actionId: 'example:list-services', component: Result },
    });
    const tester = createExtensionTester(extension);
    expect(tester.get(AiChatToolResultBlueprint.dataRefs.toolResult)).toEqual({
      actionId: 'example:list-services',
      component: Result,
    });
  });
});
