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

import express from 'express';
import Router from 'express-promise-router';
import type { Logger } from '../../application/ports';
import type { Principal } from '../../domain';
import type { ChatInputConfig } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import {
  AttachmentsController,
  type AttachmentUseCases,
} from './controllers/attachments';
import { QueueController, type QueueUseCases } from './controllers/queue';
import { RunsController, type RunUseCases } from './controllers/runs';
import { SharesController, type ShareUseCases } from './controllers/shares';
import {
  SessionsController,
  type SessionUseCases,
} from './controllers/sessions';
import { toHttpError } from './errorMapping';

export type RouterOptions = {
  /** The signed-in user of the request. Refuses a request that has none. */
  principal(req: express.Request): Promise<Principal>;
  useCases: SessionUseCases &
    RunUseCases &
    QueueUseCases &
    AttachmentUseCases &
    ShareUseCases;
  /** The answer of `GET /input-config`. */
  inputConfig: ChatInputConfig;
  logger: Logger;
  /** The time between the comment lines that keep an idle stream open; 15 seconds by default. */
  keepAliveMs?: number;
};

/**
 * The routes of the plugin (architecture, "HTTP"). A route reads the user,
 * calls its controller and answers; the error of a use case becomes the
 * error of Backstage that the backend answers with (`toHttpError`).
 */
export function createRouter(options: RouterOptions): express.Router {
  const { principal, useCases, logger, keepAliveMs, inputConfig } = options;
  const sessions = new SessionsController(useCases);
  const runs = new RunsController(useCases, logger, keepAliveMs);
  const queue = new QueueController(useCases);
  const attachments = new AttachmentsController(useCases);
  const shares = new SharesController(useCases);
  const router = Router();
  router.use(express.json({ limit: '64kb' }));

  /** Gives a route the principal and turns the errors of the use cases. */
  const route =
    (
      handler: (
        principal: Principal,
        req: express.Request,
        res: express.Response,
      ) => Promise<void>,
    ) =>
    async (req: express.Request, res: express.Response) => {
      const user = await principal(req);
      try {
        await handler(user, req, res);
      } catch (error) {
        // After the first byte the response is a stream and cannot change.
        if (res.headersSent) throw error;
        throw toHttpError(error);
      }
    };

  router.get(
    '/sessions',
    route(async (user, req, res) => {
      res.json(await sessions.list(user, req.query));
    }),
  );
  router.post(
    '/sessions',
    route(async (user, req, res) => {
      res.status(201).json(await sessions.create(user, req.body));
    }),
  );
  router.get(
    '/sessions/:id',
    route(async (user, req, res) => {
      res.json(await sessions.get(user, req.params.id, req.query));
    }),
  );
  router.patch(
    '/sessions/:id',
    route(async (user, req, res) => {
      res.json(await sessions.update(user, req.params.id, req.body));
    }),
  );
  router.delete(
    '/sessions/:id',
    route(async (user, req, res) => {
      await sessions.delete(user, req.params.id);
      res.status(204).end();
    }),
  );
  router.get(
    '/sessions/:id/tools',
    route(async (user, req, res) => {
      res.json(await sessions.tools(user, req.params.id));
    }),
  );
  router.get(
    '/sessions/:id/shares',
    route(async (user, req, res) => {
      res.json(await shares.list(user, req.params.id));
    }),
  );
  router.post(
    '/sessions/:id/shares',
    route(async (user, req, res) => {
      res.status(201).json(await shares.create(user, req.params.id, req.body));
    }),
  );
  router.patch(
    '/sessions/:id/shares/:shareId',
    route(async (user, req, res) => {
      res.json(
        await shares.update(user, req.params.id, req.params.shareId, req.body),
      );
    }),
  );
  router.delete(
    '/sessions/:id/shares/:shareId',
    route(async (user, req, res) => {
      await shares.revoke(user, req.params.id, req.params.shareId);
      res.status(204).end();
    }),
  );
  router.post(
    '/sessions/:id/fork',
    route(async (user, req, res) => {
      res.status(201).json(await shares.fork(user, req.params.id));
    }),
  );
  router.get(
    '/toolsets',
    route(async (user, _req, res) => {
      res.json(await sessions.toolsets(user));
    }),
  );

  router.get(
    '/input-config',
    route(async (_user, _req, res) => {
      res.json(inputConfig);
    }),
  );
  router.post(
    '/sessions/:id/attachments',
    route(async (user, req, res) => {
      res
        .status(201)
        .json(await attachments.upload(user, req.params.id, req, res));
    }),
  );
  router.get(
    '/sessions/:id/attachments/:attachmentId',
    route(async (user, req, res) => {
      await attachments.read(
        user,
        req.params.id,
        req.params.attachmentId,
        req,
        res,
      );
    }),
  );
  router.post(
    '/sessions/:id/runs',
    route(async (user, req, res) => {
      await runs.send(user, req.params.id, req.body, res);
    }),
  );
  router.post(
    '/sessions/:id/runs/:runId/messages',
    route(async (user, req, res) => {
      res
        .status(201)
        .json(
          await runs.insert(user, req.params.id, req.params.runId, req.body),
        );
    }),
  );
  router.post(
    '/sessions/:id/runs/:runId/cancel',
    route(async (user, req, res) => {
      await runs.cancel(user, req.params.id, req.params.runId);
      res.status(202).json({});
    }),
  );
  router.post(
    '/sessions/:id/tool-calls/:callId/decision',
    route(async (user, req, res) => {
      const answer = await runs.decide(
        user,
        req.params.id,
        req.params.callId,
        req.body,
        res,
      );
      if (answer) res.json(answer);
    }),
  );
  router.post(
    '/sessions/:id/resume',
    route(async (user, req, res) => {
      if (!(await runs.resume(user, req.params.id, req.body, res))) {
        res.status(204).end();
      }
    }),
  );
  router.get(
    '/sessions/:id/queue',
    route(async (user, req, res) => {
      res.json(await queue.list(user, req.params.id));
    }),
  );
  router.post(
    '/sessions/:id/queue',
    route(async (user, req, res) => {
      res.status(201).json(await queue.add(user, req.params.id, req.body));
    }),
  );
  router.put(
    '/sessions/:id/queue/order',
    route(async (user, req, res) => {
      res.json(await queue.reorder(user, req.params.id, req.body));
    }),
  );
  router.post(
    '/sessions/:id/queue/resume',
    route(async (user, req, res) => {
      if (!(await runs.resumeQueue(user, req.params.id, res))) {
        res.status(204).end();
      }
    }),
  );
  router.patch(
    '/sessions/:id/queue/:queuedId',
    route(async (user, req, res) => {
      res.json(
        await queue.update(user, req.params.id, req.params.queuedId, req.body),
      );
    }),
  );
  router.delete(
    '/sessions/:id/queue/:queuedId',
    route(async (user, req, res) => {
      await queue.remove(user, req.params.id, req.params.queuedId);
      res.status(204).end();
    }),
  );
  router.post(
    '/sessions/:id/queue/:queuedId/insert',
    route(async (user, req, res) => {
      res
        .status(201)
        .json(
          await queue.insert(
            user,
            req.params.id,
            req.params.queuedId,
            req.body,
          ),
        );
    }),
  );
  router.get(
    '/sessions/:id/stream',
    route(async (user, req, res) => {
      if (!(await runs.follow(user, req.params.id, req.query, res))) {
        res.status(204).end();
      }
    }),
  );

  return router;
}
