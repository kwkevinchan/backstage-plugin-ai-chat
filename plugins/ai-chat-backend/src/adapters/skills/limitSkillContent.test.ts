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

const sizeOf = (id: string, description: string, content: string) =>
  JSON.stringify({ id, description, content }).length;

describe('limitSkillContent', () => {
  it('keeps a text whose output fits, and the id and description', async () => {
    const skill = limitSkillContent(
      { id: 'short', description: 'Short.', load: () => 'x'.repeat(100) },
      200,
    );
    expect(skill).toMatchObject({ id: 'short', description: 'Short.' });
    await expect(skill.load(ctx)).resolves.toBe('x'.repeat(100));
  });

  it('cuts the text so that the whole output fits, and says how much was cut', async () => {
    const skill = limitSkillContent(
      { id: 'long', description: 'Long.', load: async () => 'y'.repeat(500) },
      200,
    );
    const content = await skill.load(ctx);
    expect(sizeOf('long', 'Long.', content)).toBeLessThanOrEqual(200);
    const kept = content.indexOf('\n');
    expect(kept).toBeGreaterThan(0);
    expect(content).toBe(
      `${'y'.repeat(kept)}\n\n[Skill cut: ${
        500 - kept
      } of 500 characters left out.]`,
    );
    // The longest prefix that fits: one more character would not.
    const longer = `${'y'.repeat(kept + 1)}\n\n[Skill cut: ${
      500 - kept - 1
    } of 500 characters left out.]`;
    expect(sizeOf('long', 'Long.', longer)).toBeGreaterThan(200);
  });

  it('cuts a text that is short but grows past maxChars as JSON', async () => {
    const text = '"\\'.repeat(40);
    const skill = limitSkillContent(
      { id: 'quotes', description: 'Quotes.', load: () => text },
      120,
    );
    expect(text.length).toBeLessThan(120);
    const content = await skill.load(ctx);
    expect(content).not.toBe(text);
    expect(content).toMatch(/\[Skill cut: \d+ of 80 characters left out\.\]$/);
    expect(sizeOf('quotes', 'Quotes.', content)).toBeLessThanOrEqual(120);
  });

  it('counts the description on one line, as the loop writes it', async () => {
    const skill = limitSkillContent(
      {
        id: 'spaced',
        description: '  Many\n\n   spaces.  ',
        load: () => 'z'.repeat(500),
      },
      150,
    );
    const content = await skill.load(ctx);
    expect(sizeOf('spaced', 'Many spaces.', content)).toBe(150);
  });

  it('passes on what is not a string, so the loop reports it', async () => {
    const skill = limitSkillContent(
      { id: 'bad', description: 'Bad.', load: (() => 42) as never },
      100,
    );
    await expect(skill.load(ctx)).resolves.toBe(42);
  });
});
