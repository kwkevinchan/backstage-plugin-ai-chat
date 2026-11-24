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

import { ATTACHMENT_TTL_HOURS } from '../../domain';
import type { Clock } from '@kwkevinchan/ai-chat-harness';
import type { AttachmentStore } from '../ports';

/**
 * Deletes the images that no message uses and no queued message holds, once
 * they are older than 24 hours (IN-04). `plugin.ts` runs it every hour.
 */
export class PurgeUnusedAttachments {
  constructor(
    private readonly deps: { attachments: AttachmentStore; clock: Clock },
  ) {}

  /** Returns how many images were deleted. */
  async execute(): Promise<number> {
    const { attachments, clock } = this.deps;
    const olderThan = new Date(
      clock.now().getTime() - ATTACHMENT_TTL_HOURS * 3600 * 1000,
    );
    return attachments.purgeUnused(olderThan);
  }
}
