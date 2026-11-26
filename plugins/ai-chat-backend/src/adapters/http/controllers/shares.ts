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

import type {
  ChatShare,
  ChatShareList,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type {
  ListShares,
  RevokeShare,
  ShareSession,
  UpdateShare,
} from '../../../application';
import type { Principal } from '../../../domain';
import { toChatShare } from '../presenters/session';
import { createShareBody, parse, updateShareBody } from '../requestSchemas';

export type ShareUseCases = {
  listShares: Pick<ListShares, 'execute'>;
  shareSession: Pick<ShareSession, 'execute'>;
  updateShare: Pick<UpdateShare, 'execute'>;
  revokeShare: Pick<RevokeShare, 'execute'>;
};

/** The shares of a session; only its owner reaches them (SH-01, SH-10). */
export class SharesController {
  constructor(private readonly useCases: ShareUseCases) {}

  /** `GET /sessions/:id/shares` */
  async list(principal: Principal, sessionId: string): Promise<ChatShareList> {
    const shares = await this.useCases.listShares.execute({
      principal,
      sessionId,
    });
    return { items: shares.map(toChatShare) };
  }

  /** `POST /sessions/:id/shares` */
  async create(
    principal: Principal,
    sessionId: string,
    body: unknown,
  ): Promise<ChatShare> {
    const request = parse(createShareBody, body);
    return toChatShare(
      await this.useCases.shareSession.execute({
        principal,
        sessionId,
        subjectRef: request.subjectRef,
        ...(request.mode !== undefined && { mode: request.mode }),
        ...(request.includeToolOutputs !== undefined && {
          includeToolOutputs: request.includeToolOutputs,
        }),
        ...(request.includeLaterToolOutputs !== undefined && {
          includeLaterToolOutputs: request.includeLaterToolOutputs,
        }),
        ...(request.hours !== undefined && { hours: request.hours }),
      }),
    );
  }

  /** `PATCH /sessions/:id/shares/:shareId` */
  async update(
    principal: Principal,
    sessionId: string,
    shareId: string,
    body: unknown,
  ): Promise<ChatShare> {
    const change = parse(updateShareBody, body);
    return toChatShare(
      await this.useCases.updateShare.execute({
        principal,
        sessionId,
        shareId,
        ...(change.refresh !== undefined && { refresh: change.refresh }),
        ...(change.includeToolOutputs !== undefined && {
          includeToolOutputs: change.includeToolOutputs,
        }),
        ...(change.includeLaterToolOutputs !== undefined && {
          includeLaterToolOutputs: change.includeLaterToolOutputs,
        }),
        ...(change.hours !== undefined && { hours: change.hours }),
      }),
    );
  }

  /** `DELETE /sessions/:id/shares/:shareId` */
  async revoke(
    principal: Principal,
    sessionId: string,
    shareId: string,
  ): Promise<void> {
    await this.useCases.revokeShare.execute({ principal, sessionId, shareId });
  }
}
