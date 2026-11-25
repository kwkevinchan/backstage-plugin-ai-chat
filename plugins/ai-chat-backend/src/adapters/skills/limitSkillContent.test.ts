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

import type { StepContext } from '@kwkevinchan/ai-chat-harness';
import { limitSkillContent } from './limitSkillContent';

const ctx: StepContext = {
  sessionId: 's',
  runId: 'r',
  principal: {},
  agentId: 'default',
  step: 1,
  signal: new AbortController().signal,
};

describe('limitSkillContent', () => {
  it('keeps a text that fits, and the id and description', async () => {
    const skill = limitSkillContent(
      { id: 'short', description: 'Short.', load: () => 'x'.repeat(100) },
      100,
    );
    expect(skill).toMatchObject({ id: 'short', description: 'Short.' });
    await expect(skill.load(ctx)).resolves.toBe('x'.repeat(100));
  });

  it('cuts a longer text to maxChars and ends it with how much was cut', async () => {
    const skill = limitSkillContent(
      { id: 'long', description: 'Long.', load: async () => 'y'.repeat(101) },
      100,
    );
    const content = await skill.load(ctx);
    expect(content.length).toBeLessThanOrEqual(100);
    const kept = content.indexOf('\n');
    expect(content).toBe(
      `${'y'.repeat(kept)}\n\n[Skill cut: ${
        101 - kept
      } of 101 characters left out.]`,
    );
  });

  it('passes on what is not a string, so the loop reports it', async () => {
    const skill = limitSkillContent(
      { id: 'bad', description: 'Bad.', load: (() => 42) as never },
      100,
    );
    await expect(skill.load(ctx)).resolves.toBe(42);
  });
});
