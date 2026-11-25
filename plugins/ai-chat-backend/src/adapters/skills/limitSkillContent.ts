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
 * `skill` with the text its `load` returns cut to `maxChars` characters, as
 * the tool gateway cuts the output of an action (`aiChat.maxToolOutputChars`).
 * `load_skill` does not go through the gateway, so without this one long
 * skill could take the whole token budget of the run. The cut text ends with
 * a line that says how much was left out.
 */
export function limitSkillContent(skill: Skill, maxChars: number): Skill {
  return {
    id: skill.id,
    description: skill.description,
    async load(ctx) {
      const content = await skill.load(ctx);
      if (typeof content !== 'string' || content.length <= maxChars) {
        return content;
      }
      // The notice is shorter than the smallest `maxChars` (100), so some of
      // the text is always kept.
      const noticeOf = (cut: number) =>
        `\n\n[Skill cut: ${cut} of ${content.length} characters left out.]`;
      const kept = Math.max(0, maxChars - noticeOf(content.length).length);
      return content.slice(0, kept) + noticeOf(content.length - kept);
    },
  };
}
