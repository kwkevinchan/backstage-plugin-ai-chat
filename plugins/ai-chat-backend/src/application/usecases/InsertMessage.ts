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

import {
  LeaseLost,
  type Item,
  type ItemLog,
  type PageContext,
} from '@kwkevinchan/ai-chat-harness';
import { assertOwner, RunNotRunning, type Principal } from '../../domain';
import {
  bindAttachments,
  toAttachmentRef,
  type ImageSettings,
} from '../attachments';
import {
  resolveReferences,
  type ReferenceInput,
  type ReferenceSettings,
} from '../references';
import type {
  AttachmentStore,
  EntityReader,
  Logger,
  SessionRepository,
} from '../ports';

/**
 * The user adds a message to the run that is running (IN-10). The message is
 * an item of the log; the loop reads the log at every step (D-18), so it
 * reads the message in its next model call. No run starts and no loop is
 * started: the request only writes, so it works on whichever backend gets it,
 * not only on the one that runs the loop.
 */
export class InsertMessage {
  constructor(
    private readonly deps: {
      sessions: SessionRepository;
      items: ItemLog;
      attachments: AttachmentStore;
      images: ImageSettings;
      entities: EntityReader;
      references: ReferenceSettings;
      logger?: Logger;
    },
  ) {}

  /**
   * Returns the item that was written. Throws `NotSessionOwner`,
   * `RunNotRunning` (the run waits for an approval, has ended, is another run
   * or has no live lease), `InsertLimitReached`, or, for the images,
   * `ImagesNotSupported`, `TooManyAttachments`, `UnknownAttachment` or
   * `TooManyImageBytes` (the images of the messages of the run, with these,
   * are over the limit; checked in the transaction of the write), or
   * `TooManyReferences`.
   */
  async execute(input: {
    principal: Principal;
    sessionId: string;
    runId: string;
    text: string;
    attachmentIds?: string[];
    page?: PageContext;
    references?: ReferenceInput[];
  }): Promise<Item> {
    const { sessions, items } = this.deps;
    const session = await sessions.get(input.sessionId);
    assertOwner(session, input.principal);
    const attachments = await bindAttachments(
      this.deps,
      session.id,
      input.attachmentIds,
    );
    const references = await resolveReferences(
      this.deps,
      input.principal,
      input.references,
    );
    try {
      // The owner of the lease is not checked: the host writes for the user,
      // and does not hold the lease of the run.
      const [item] = await items.append(
        session.id,
        [
          {
            kind: 'user_message',
            text: input.text,
            ...(attachments.length > 0 && {
              attachments: attachments.map(toAttachmentRef),
            }),
            ...(input.page && { page: input.page }),
            ...(references.length > 0 && { references }),
            delivery: 'inserted',
          },
        ],
        { runId: input.runId, leaseOwner: '' },
      );
      return item;
    } catch (error) {
      if (error instanceof LeaseLost) throw new RunNotRunning(input.runId);
      throw error;
    }
  }
}
