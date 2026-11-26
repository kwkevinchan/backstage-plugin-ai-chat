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

import { FakeClock } from '@kwkevinchan/ai-chat-harness/testing';
import type { LeasedRun, Principal, Session } from '../domain';
import { buildRunRequest } from './buildRunRequest';
import { DEFAULT_MODEL_ID, ModelCatalog } from './models';
import type { AgentCatalog } from './ports';

const agents = {
  agent: async (id: string) => ({ id, systemPrompt: 'Rules.' }),
  policy: async () => ({}),
} as unknown as AgentCatalog;
const model = {
  capabilities: { parallelToolCalls: false, images: false },
  async *stream() {},
};
const deps = {
  agents,
  models: new ModelCatalog(new Map([[DEFAULT_MODEL_ID, model]])),
  clock: new FakeClock(),
  settings: {
    limits: {
      maxSteps: 10,
      maxToolCallsPerRun: 30,
      runTimeoutSeconds: 300,
      maxToolCallsPerStep: 8,
      readConcurrency: 4,
      toolTimeoutSeconds: 60,
    },
    budget: { tokenBudget: 1000, keepRecentSteps: 6 },
  },
};
const session: Session = {
  id: 's1',
  ownerRef: 'user:default/jane',
  agentId: 'default',
  enabledToolsets: [],
  pinned: false,
  createdAt: 'x',
  updatedAt: 'x',
};
const run = {
  id: 'r1',
  sessionId: 's1',
  usage: { stepsUsed: 0, toolCallsUsed: 0, elapsedSeconds: 0 },
  fence: { runId: 'r1', leaseOwner: 'a' },
} as unknown as LeasedRun;
const principal: Principal = {
  userRef: 'user:default/jane',
  ownershipRefs: [],
  credentials: {},
};

describe('buildRunRequest', () => {
  it('gives the loop the entity the session is bound to (SE-02)', async () => {
    const request = await buildRunRequest(deps, {
      session: { ...session, entityRef: 'component:default/shop' },
      run,
      principal,
      page: { path: '/catalog/x', entityRef: 'component:default/other' },
    });
    expect(request.ctx).toEqual({
      sessionId: 's1',
      runId: 'r1',
      principal,
      page: { path: '/catalog/x', entityRef: 'component:default/other' },
      sessionEntityRef: 'component:default/shop',
    });
  });

  it('has no entity for a session bound to none', async () => {
    const request = await buildRunRequest(deps, { session, run, principal });
    expect(request.ctx).not.toHaveProperty('sessionEntityRef');
  });

  it('names the model of the agent for the measurements, default when the agent names none (O-01)', async () => {
    const small = { ...model };
    const withModels = {
      ...deps,
      agents: {
        agent: async (id: string) => ({
          id,
          systemPrompt: 'Rules.',
          ...(id === 'sre' && { model: 'small' }),
        }),
        policy: async () => ({}),
      } as unknown as AgentCatalog,
      models: new ModelCatalog(
        new Map([
          [DEFAULT_MODEL_ID, model],
          ['small', small],
        ]),
      ),
    };
    const plain = await buildRunRequest(withModels, {
      session,
      run,
      principal,
    });
    const sre = await buildRunRequest(withModels, {
      session: { ...session, agentId: 'sre' },
      run,
      principal,
    });
    expect(plain.modelId).toBe('default');
    expect(sre.modelId).toBe('small');
    expect(sre.model).toBe(small);
  });
});
