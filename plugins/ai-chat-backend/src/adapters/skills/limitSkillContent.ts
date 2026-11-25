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

import type { Skill } from '@kwkevinchan/ai-chat-harness';

/**
 * `skill` with the text its `load` returns cut so that the output of
 * `load_skill`, `{ id, description, content }` serialized as JSON, is at most
 * `maxChars` characters, as the tool gateway cuts the output of an action
 * (`aiChat.maxToolOutputChars`). `load_skill` does not go through the gateway,
 * so without this one long skill could take the whole token budget of the
 * run, and the cut after `afterToolCall` hooks would replace the output. The
 * cut text ends with a line that says how much was left out.
 */
export function limitSkillContent(skill: Skill, maxChars: number): Skill {
  // The loop puts the description on one line in the output.
  const description = skill.description.replace(/\s+/g, ' ').trim();
  return {
    id: skill.id,
    description: skill.description,
    async load(ctx) {
      const content = await skill.load(ctx);
      if (typeof content !== 'string') return content;
      const size = (text: string) =>
        JSON.stringify({ id: skill.id, description, content: text }).length;
      if (size(content) <= maxChars) return content;
      const cut = (length: number) =>
        `${content.slice(0, length)}\n\n[Skill cut: ${
          content.length - length
        } of ${content.length} characters left out.]`;
      // The longest prefix whose output fits. The size only grows with the
      // prefix (the count in the notice loses a digit at most where the
      // prefix gains one), so a binary search finds it.
      let low = 0;
      let high = content.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (size(cut(mid)) <= maxChars) low = mid;
        else high = mid - 1;
      }
      return cut(low);
    },
  };
}
