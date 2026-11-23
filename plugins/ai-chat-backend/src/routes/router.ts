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

import type { HttpAuthService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import { MAX_MESSAGE_LENGTH } from '../common';
import type { ChatCaller, ChatService } from '../chat/ChatService';
import { SseResponse } from './sse';

export interface RouterOptions {
  httpAuth: HttpAuthService;
  chat: ChatService;
}

const messageBody = z.object({
  content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new InputError(
      `Invalid request body: ${result.error.issues
        .map(i => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

/**
 * The routes of the chat. Every route needs the credentials of a signed-in
 * user: a service token is refused, because a conversation belongs to a user.
 */
export function createRouter(options: RouterOptions): express.Router {
  const { httpAuth, chat } = options;
  const router = Router();
  router.use(express.json({ limit: '64kb' }));

  async function callerOf(req: express.Request): Promise<ChatCaller> {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    return {
      credentials,
      userEntityRef: credentials.principal.userEntityRef,
      request: req,
    };
  }

  /** Runs `fn` with a response stream and ends the response. */
  async function streamed(
    res: express.Response,
    fn: (sse: SseResponse) => Promise<void>,
  ) {
    const sse = new SseResponse(res);
    try {
      await fn(sse);
    } catch (error) {
      // Before the first event the error handler of the backend answers.
      if (!sse.hasStarted) throw error;
      sse.finish(error);
      return;
    }
    sse.finish();
  }

  router.get('/conversations', async (req, res) => {
    const caller = await callerOf(req);
    res.json({ items: await chat.listConversations(caller) });
  });

  router.post('/conversations', async (req, res) => {
    const caller = await callerOf(req);
    res.status(201).json(await chat.createConversation(caller));
  });

  router.get('/conversations/:id', async (req, res) => {
    const caller = await callerOf(req);
    res.json(await chat.getConversation(caller, req.params.id));
  });

  router.delete('/conversations/:id', async (req, res) => {
    const caller = await callerOf(req);
    await chat.deleteConversation(caller, req.params.id);
    res.status(204).end();
  });

  router.post('/conversations/:id/messages', async (req, res) => {
    const caller = await callerOf(req);
    const { content } = parse(messageBody, req.body);
    await streamed(res, sse =>
      chat.sendMessage(caller, req.params.id, content, sse.stream),
    );
  });

  router.post(
    '/conversations/:id/tool-calls/:callId/approve',
    async (req, res) => {
      const caller = await callerOf(req);
      await streamed(res, sse =>
        chat.approve(caller, req.params.id, req.params.callId, sse.stream),
      );
    },
  );

  router.post(
    '/conversations/:id/tool-calls/:callId/reject',
    async (req, res) => {
      const caller = await callerOf(req);
      await streamed(res, sse =>
        chat.reject(caller, req.params.id, req.params.callId, sse.stream),
      );
    },
  );

  return router;
}
