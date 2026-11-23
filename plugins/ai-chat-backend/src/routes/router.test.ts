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

import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import { ConflictError } from '@backstage/errors';
import express from 'express';
import request from 'supertest';
import type { ChatService } from '../chat/ChatService';
import { createRouter } from './router';

function app(sendMessage: ChatService['sendMessage']) {
  const logger = mockServices.logger.mock();
  const router = createRouter({
    httpAuth: mockServices.httpAuth(),
    chat: { sendMessage } as unknown as ChatService,
    logger,
  });
  const server = express().use(router);
  return { server, logger };
}

const alice = mockCredentials.user.header('user:default/alice');

describe('a failure after the stream started', () => {
  it('is logged, and the browser gets a fixed text instead of the error', async () => {
    const { server, logger } = app(async (_caller, _id, _content, stream) => {
      stream.emit({ type: 'notice', message: 'started' });
      throw new Error('insert into "messages" failed: connection refused');
    });
    const res = await request(server)
      .post('/conversations/c1/messages')
      .set('Authorization', alice)
      .send({ content: 'hi' })
      .expect(200);
    expect(res.text).toContain('The chat failed. Try again');
    expect(res.text).not.toContain('insert into');
    expect(res.text).not.toContain('connection refused');
    expect(logger.error).toHaveBeenCalledWith(
      'A response stream failed after it started',
      expect.objectContaining({
        message: expect.stringContaining('insert into'),
      }),
    );
  });

  it('shows the message of an error that the user can act on', async () => {
    const { server } = app(async (_caller, _id, _content, stream) => {
      stream.emit({ type: 'notice', message: 'started' });
      throw new ConflictError(
        'An action of this conversation was just decided',
      );
    });
    const res = await request(server)
      .post('/conversations/c1/messages')
      .set('Authorization', alice)
      .send({ content: 'hi' });
    expect(res.text).toContain(
      'An action of this conversation was just decided',
    );
  });
});
