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

import type { ToolGateway } from '@kwkevinchan/ai-chat-harness';
import { assertOwner, type Principal } from '../../domain';
import type { SessionRepository } from '../ports';

/** A tool of a session, as the screen shows it. */
export type SessionTool = {
  id: string;
  title?: string;
  description: string;
  readOnly: boolean;
};

/**
 * The tools that the session offers to the model now, listed with the
 * credentials of the user. The screen shows a call with them: the title, what
 * it does, and whether it changes anything.
 */
export class ListSessionTools {
  constructor(
    private readonly deps: { sessions: SessionRepository; tools: ToolGateway },
  ) {}

  async execute(input: {
    principal: Principal;
    sessionId: string;
  }): Promise<SessionTool[]> {
    const { sessions, tools } = this.deps;
    assertOwner(await sessions.get(input.sessionId), input.principal);
    const listed = await tools.list({
      sessionId: input.sessionId,
      runId: '',
      principal: input.principal,
    });
    return listed.map(tool => ({
      id: tool.id,
      ...(tool.title !== undefined && { title: tool.title }),
      description: withoutTitle(tool.description, tool.title),
      readOnly: tool.readOnly === true,
    }));
  }
}

/** The description for the model starts with the title; the screen has the title apart. */
function withoutTitle(description: string, title?: string): string {
  const prefix = title === undefined ? '' : `${title}: `;
  return prefix && description.startsWith(prefix)
    ? description.slice(prefix.length)
    : description;
}
