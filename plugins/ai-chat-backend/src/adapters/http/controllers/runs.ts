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

import { ConflictError } from '@backstage/errors';
import type { Response } from 'express';
import type {
  CancelRun,
  DecideApproval,
  FollowSession,
  InsertMessage,
  ResumeQueue,
  ResumeRun,
  RunHandle,
  SendMessage,
} from '../../../application';
import type { Logger } from '../../../application/ports';
import type { Principal } from '../../../domain';
import type {
  ChatDecisionResponse,
  ChatItem,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import { UiMessageStreamPresenter } from '../presenters/uiMessageStream';
import {
  afterSeqQuery,
  decisionBody,
  insertMessageBody,
  parse,
  resumeBody,
  sendMessageBody,
} from '../requestSchemas';
import { sendUiMessageStream } from '../sse';

export type RunUseCases = {
  sendMessage: Pick<SendMessage, 'execute'>;
  decideApproval: Pick<DecideApproval, 'execute'>;
  resumeRun: Pick<ResumeRun, 'execute'>;
  insertMessage: Pick<InsertMessage, 'execute'>;
  resumeQueue: Pick<ResumeQueue, 'execute'>;
  cancelRun: Pick<CancelRun, 'execute'>;
  followSession: Pick<FollowSession, 'execute'>;
};

/**
 * The routes of the runs. Each one that starts, continues or follows a run
 * answers with a UI message stream (or 204 when there is nothing to stream);
 * the use case refuses before the first byte, so a refusal is a normal error
 * response.
 */
export class RunsController {
  constructor(
    private readonly useCases: RunUseCases,
    private readonly logger: Logger,
    private readonly keepAliveMs?: number,
  ) {}

  /** `POST /sessions/:id/runs` */
  async send(
    principal: Principal,
    sessionId: string,
    body: unknown,
    res: Response,
  ): Promise<void> {
    const { text, page } = parse(sendMessageBody, body);
    const handle = await this.useCases.sendMessage.execute({
      principal,
      sessionId,
      text,
      ...(page && { page }),
    });
    await this.stream(res, handle);
  }

  /**
   * `POST /sessions/:id/tool-calls/:callId/decision`. The last decision
   * that a run waited for carries the run on, and the response is the stream
   * of the run, which begins with the decision. Any other decision gets JSON.
   */
  async decide(
    principal: Principal,
    sessionId: string,
    callId: string,
    body: unknown,
    res: Response,
  ): Promise<ChatDecisionResponse | undefined> {
    const { approved, page } = parse(decisionBody, body);
    const result = await this.useCases.decideApproval.execute({
      principal,
      sessionId,
      callId,
      decision: approved ? 'allow' : 'deny',
      ...(page && { page }),
    });
    if (!result.run) return { approved: result.decision === 'allow' };
    await this.stream(res, result.run, [
      {
        type: 'tool-approval-response',
        approvalId: callId,
        approved: result.decision === 'allow',
      },
    ]);
    return undefined;
  }

  /** `POST /sessions/:id/resume`: false when there is nothing to carry on. */
  async resume(
    principal: Principal,
    sessionId: string,
    body: unknown,
    res: Response,
  ): Promise<boolean> {
    const { page } = parse(resumeBody, body);
    const handle = await this.useCases.resumeRun.execute({
      principal,
      sessionId,
      ...(page && { page }),
    });
    if (!handle) return false;
    await this.stream(res, handle);
    return true;
  }

  /** `POST /sessions/:id/runs/:runId/messages`: the item that was written. */
  async insert(
    principal: Principal,
    sessionId: string,
    runId: string,
    body: unknown,
  ): Promise<ChatItem> {
    const { text, page } = parse(insertMessageBody, body);
    return this.useCases.insertMessage.execute({
      principal,
      sessionId,
      runId,
      text,
      ...(page && { page }),
    });
  }

  /** `POST /sessions/:id/queue/resume`: false when there is nothing to send. */
  async resumeQueue(
    principal: Principal,
    sessionId: string,
    res: Response,
  ): Promise<boolean> {
    const handle = await this.useCases.resumeQueue.execute({
      principal,
      sessionId,
    });
    if (!handle) return false;
    await this.stream(res, handle);
    return true;
  }

  /** `POST /sessions/:id/runs/:runId/cancel` */
  async cancel(
    principal: Principal,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const accepted = await this.useCases.cancelRun.execute({
      principal,
      sessionId,
      runId,
    });
    if (!accepted) throw new ConflictError(`Run ${runId} has ended`);
  }

  /** `GET /sessions/:id/stream`: false when there is nothing to follow. */
  async follow(
    principal: Principal,
    sessionId: string,
    query: unknown,
    res: Response,
  ): Promise<boolean> {
    const { afterSeq } = parse(afterSeqQuery, query);
    const followed = await this.useCases.followSession.execute({
      principal,
      sessionId,
      ...(afterSeq !== undefined && { afterSeq }),
    });
    if (!followed) return false;
    const presenter = new UiMessageStreamPresenter({
      runId: followed.run.id,
      typing: false,
    });
    await sendUiMessageStream(
      res,
      {
        events: followed.events,
        presenter,
        head: presenter.replay(
          followed.run.status,
          followed.items,
          followed.upToSeq,
          followed.inserted,
        ),
      },
      this.logger,
      this.keepAliveMs,
    );
    return true;
  }

  private stream(
    res: Response,
    handle: RunHandle,
    afterStart?: ConstructorParameters<
      typeof UiMessageStreamPresenter
    >[0]['afterStart'],
  ): Promise<void> {
    return sendUiMessageStream(
      res,
      {
        events: handle.events,
        presenter: new UiMessageStreamPresenter({
          runId: handle.runId,
          ...(afterStart && { afterStart }),
        }),
      },
      this.logger,
      this.keepAliveMs,
    );
  }
}
