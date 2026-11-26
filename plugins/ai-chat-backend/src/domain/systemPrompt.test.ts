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

import { buildSystemPrompt } from './systemPrompt';

describe('buildSystemPrompt', () => {
  it('returns the built-in rules including fenced code block guidance', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Rules that always apply:');
    expect(prompt).toContain(
      'Answer in the language of the user. Use Markdown.',
    );
    expect(prompt).toContain(
      'Put JSON, code, commands, and configuration files in fenced Markdown code blocks with a language tag',
    );
    expect(prompt).toContain('Pretty-print JSON across multiple lines');
    expect(prompt).not.toContain('Instructions of the operator');
  });

  it('appends trimmed operator instructions after the built-in rules', () => {
    const prompt = buildSystemPrompt('  Prefer short answers.  ');
    expect(prompt).toContain('Rules that always apply:');
    expect(prompt).toContain(
      '\n\nInstructions of the operator of this Backstage:\nPrefer short answers.',
    );
  });

  it('ignores blank operator instructions', () => {
    expect(buildSystemPrompt('   \n\t  ')).toBe(buildSystemPrompt());
  });
});
