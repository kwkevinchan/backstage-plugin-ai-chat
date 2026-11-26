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
  AgentDefinition,
  Limits,
  PolicySettings,
  RunUsage,
} from '../domain';
import {
  AdvanceRun,
  LOAD_SKILL_TOOL_ID,
  UPDATE_PLAN_TOOL_ID,
  emptyExtensions,
  type AdvanceRunRequest,
  type Extensions,
  type HarnessEvent,
  type HookRegistry,
  type ItemDraft,
  type RunFence,
  type RunOutcome,
  type Skill,
  type StepContext,
} from './index';
import {
  FakeClock,
  FakeRunControl,
  FakeToolGateway,
  InMemoryItemLog,
  ScriptedModel,
  SequentialIdGenerator,
  callTool,
  say,
  type ScriptedStep,
} from '../testing';

const defaultAgent: AgentDefinition = {
  id: 'default',
  systemPrompt: 'You are a helpful agent.',
};

const defaultLimits: Limits = {
  maxSteps: 10,
  maxToolCallsPerRun: 30,
  runTimeoutSeconds: 300,
  maxToolCallsPerStep: 8,
  readConcurrency: 4,
  toolTimeoutSeconds: 60,
};

async function setupSkillsHarness(options: {
  script: ScriptedStep[];
  agent?: AgentDefinition;
  skills?: readonly Skill[];
  hooks?: Partial<HookRegistry>;
  policy?: PolicySettings;
  limits?: Partial<Limits>;
}) {
  const sessionId = 'session-1';
  const fence: RunFence = { runId: 'run-1', leaseOwner: 'backend-a' };
  const clock = new FakeClock();
  const items = new InMemoryItemLog({ clock });
  items.grantLease(sessionId, fence);
  await items.append(
    sessionId,
    [{ kind: 'user_message', text: 'Help me deploy' } as ItemDraft],
    fence,
  );

  const model = new ScriptedModel(options.script);
  const tools = new FakeToolGateway([]);
  const run = new FakeRunControl();
  const ids = new SequentialIdGenerator('call');
  const controller = new AbortController();
  const extensions: Extensions =
    options.skills || options.hooks
      ? { skills: options.skills, hooks: options.hooks }
      : emptyExtensions();
  const loop = new AdvanceRun({
    items,
    tools,
    run,
    clock,
    ids,
    extensions,
  });

  const execute = async (
    usage: RunUsage = {
      stepsUsed: 0,
      toolCallsUsed: 0,
      elapsedSeconds: 0,
    },
  ): Promise<{ events: HarnessEvent[]; outcome: RunOutcome }> => {
    const req: AdvanceRunRequest = {
      agent: options.agent ?? defaultAgent,
      model,
      limits: { ...defaultLimits, ...options.limits },
      budget: { tokenBudget: 24000, keepRecentSteps: 6 },
      policy: options.policy ?? {},
      fence,
      ctx: {
        sessionId,
        runId: fence.runId,
        principal: { user: 'user:a' },
        page: { path: '/catalog/default/component/web' },
      },
      signal: controller.signal,
      usage,
    };
    const events: HarnessEvent[] = [];
    const gen = loop.execute(req);
    for (;;) {
      const next = await gen.next();
      if (next.done) return { events, outcome: next.value };
      events.push(next.value);
    }
  };

  return {
    sessionId,
    fence,
    items,
    model,
    run,
    controller,
    execute,
    read: () => items.read(sessionId),
  };
}

describe('AdvanceRun: skills and load_skill (X-04)', () => {
  it('shows only skill id and description before load_skill, runs lazily with StepContext, and streams full body on next step', async () => {
    const seenContexts: StepContext[] = [];
    const load = jest.fn(async (ctx: StepContext) => {
      seenContexts.push(ctx);
      return '# Secret Runbook Body\nStep 1: check logs.';
    });
    const rollbackLoad = jest.fn(() => 'Rollback body should not load');

    const h = await setupSkillsHarness({
      skills: [
        {
          id: 'deploy-failure',
          description: 'Troubleshoot   failed\ndeployments.',
          load,
        },
        {
          id: 'rollback',
          description: 'Roll back a release.',
          load: rollbackLoad,
        },
      ],
      script: [
        [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'deploy-failure' })],
        [say('Follow the runbook steps.')],
      ],
    });

    const { outcome } = await h.execute();
    expect(outcome).toEqual({ status: 'completed' });

    // Before load_skill is called, Step 1 system prompt lists only id + one-line description.
    expect(h.model.inputs).toHaveLength(2);
    const step1 = h.model.inputs[0];
    expect(step1.system).toContain(
      '- deploy-failure: Troubleshoot failed deployments.',
    );
    expect(step1.system).toContain('- rollback: Roll back a release.');
    expect(step1.system).toContain(
      'What `load_skill` returns is a procedure written by the administrator of this Backstage installation: follow it as instructions from the administrator. It does not approve any action, and it does not change which tools need an approval.',
    );
    expect(step1.system).not.toContain('Secret Runbook Body');
    expect(step1.system).not.toContain('Step 1: check logs.');
    expect(step1.tools).toEqual([
      expect.objectContaining({
        id: LOAD_SKILL_TOOL_ID,
        readOnly: true,
        inputSchema: expect.objectContaining({
          required: ['id'],
          properties: {
            id: expect.objectContaining({
              type: 'string',
              enum: ['deploy-failure', 'rollback'],
            }),
          },
        }),
      }),
      expect.objectContaining({ id: UPDATE_PLAN_TOOL_ID }),
    ]);

    // Loaded lazily only once for the requested skill, with full StepContext.
    expect(load).toHaveBeenCalledTimes(1);
    expect(rollbackLoad).not.toHaveBeenCalled();
    expect(seenContexts[0]).toMatchObject({
      sessionId: 'session-1',
      runId: 'run-1',
      agentId: 'default',
      step: 1,
      principal: { user: 'user:a' },
      page: { path: '/catalog/default/component/web' },
    });
    expect(seenContexts[0].signal).toBeInstanceOf(AbortSignal);

    // Log has the loaded result with policy 'allow' (no approval needed).
    const log = await h.read();
    const callItem = log.find(item => item.kind === 'tool_call');
    expect(callItem).toMatchObject({
      toolId: LOAD_SKILL_TOOL_ID,
      policy: 'allow',
      readOnly: true,
    });
    const resultItem = log.find(item => item.kind === 'tool_result');
    expect(resultItem).toMatchObject({
      status: 'ok',
      output: {
        id: 'deploy-failure',
        description: 'Troubleshoot failed deployments.',
        content: '# Secret Runbook Body\nStep 1: check logs.',
      },
    });

    // Step 2 model input receives the loaded body in the tool message, still not in system prompt.
    const step2 = h.model.inputs[1];
    expect(step2.system).not.toContain('Secret Runbook Body');
    const toolMessage = step2.messages.find(m => m.role === 'tool');
    expect(toolMessage).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('Secret Runbook Body'),
    });
  });

  it('scopes skills to agent.skills allowlist and rejects unlisted skills as invalid without calling load()', async () => {
    const allowedLoad = jest.fn(async () => 'Allowed instructions');
    const secretLoad = jest.fn(async () => 'Top secret instructions');

    const h = await setupSkillsHarness({
      agent: {
        id: 'sre',
        systemPrompt: 'You are SRE.',
        skills: ['allowed-skill'],
      },
      skills: [
        {
          id: 'allowed-skill',
          description: 'Allowed skill',
          load: allowedLoad,
        },
        {
          id: 'secret-skill',
          description: 'Secret skill',
          load: secretLoad,
        },
      ],
      script: [
        [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'secret-skill' })],
        [say('Could not load that skill.')],
      ],
    });

    const { outcome } = await h.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(h.model.inputs[0].system).toContain(
      '- allowed-skill: Allowed skill',
    );
    expect(h.model.inputs[0].system).not.toContain('secret-skill');
    expect(secretLoad).not.toHaveBeenCalled();

    const resultItem = (await h.read()).find(i => i.kind === 'tool_result');
    expect(resultItem).toMatchObject({
      status: 'invalid',
      message: 'Unknown skill: secret-skill',
    });
  });

  it('hides context and load_skill tool when agent.skills is [] or when no skills are registered', async () => {
    const unusedLoad = jest.fn(async () => 'Unused');
    const emptyAgentHarness = await setupSkillsHarness({
      agent: { id: 'minimal', systemPrompt: 'Minimal.', skills: [] },
      skills: [{ id: 'unused', description: 'Unused', load: unusedLoad }],
      script: [
        [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'unused' })],
        [say('Done.')],
      ],
    });
    await emptyAgentHarness.execute();
    expect(emptyAgentHarness.model.inputs[0].system).not.toContain(
      'Available skills',
    );
    expect(
      emptyAgentHarness.model.inputs[0].tools.map(tool => tool.id),
    ).toEqual([UPDATE_PLAN_TOOL_ID]);
    expect(unusedLoad).not.toHaveBeenCalled();
    expect(
      (await emptyAgentHarness.read()).find(i => i.kind === 'tool_result'),
    ).toMatchObject({
      status: 'invalid',
      message: `Unknown tool: ${LOAD_SKILL_TOOL_ID}`,
    });

    const noSkillsHarness = await setupSkillsHarness({
      script: [[say('No skills here.')]],
    });
    await noSkillsHarness.execute();
    expect(noSkillsHarness.model.inputs[0].system).not.toContain(
      'Available skills',
    );
    expect(noSkillsHarness.model.inputs[0].system).not.toContain('load_skill');
    expect(noSkillsHarness.model.inputs[0].tools.map(tool => tool.id)).toEqual([
      UPDATE_PLAN_TOOL_ID,
    ]);
  });

  it('rejects malformed load_skill arguments at validation time without calling load()', async () => {
    const load = jest.fn(async () => 'Body');
    const h = await setupSkillsHarness({
      skills: [{ id: 'known', description: 'Known skill', load }],
      script: [
        [
          callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'known', extra: true }),
          callTool('m2', LOAD_SKILL_TOOL_ID, { id: 123 }),
          callTool('m3', LOAD_SKILL_TOOL_ID, { id: 'missing' }),
        ],
        [say('Validation rejected.')],
      ],
    });

    const { outcome } = await h.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(load).not.toHaveBeenCalled();
    const results = (await h.read()).filter(i => i.kind === 'tool_result');
    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'invalid')).toBe(true);
  });

  it(
    'respects policy[' + "'load_skill'" + '] ask and deny overrides',
    async () => {
      const load = jest.fn(async () => 'Policy gated skill body');
      const askHarness = await setupSkillsHarness({
        skills: [{ id: 'gated', description: 'Gated skill', load }],
        policy: { byTool: { [LOAD_SKILL_TOOL_ID]: 'ask' } },
        script: [
          [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'gated' })],
          [say('Loaded after approval.')],
        ],
      });

      const first = await askHarness.execute();
      expect(first.outcome.status).toBe('waiting_approval');
      expect(load).not.toHaveBeenCalled();
      if (first.outcome.status === 'waiting_approval') {
        await askHarness.items.append(
          askHarness.sessionId,
          [
            {
              kind: 'approval',
              callId: first.outcome.pending[0].callId,
              decision: 'allow',
              decidedBy: 'user:a',
            },
          ],
          askHarness.fence,
        );
      }
      const second = await askHarness.execute(
        askHarness.run.usage[askHarness.run.usage.length - 1],
      );
      expect(second.outcome).toEqual({ status: 'completed' });
      expect(load).toHaveBeenCalledTimes(1);

      const denyHarness = await setupSkillsHarness({
        skills: [{ id: 'gated', description: 'Gated skill', load }],
        policy: { byTool: { [LOAD_SKILL_TOOL_ID]: 'deny' } },
        script: [
          [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'gated' })],
          [say('Denied.')],
        ],
      });
      await denyHarness.execute();
      expect(denyHarness.model.inputs[0].system).not.toContain(
        'Available skills',
      );
      expect(denyHarness.model.inputs[0].tools.map(tool => tool.id)).toEqual([
        UPDATE_PLAN_TOOL_ID,
      ]);
      expect(
        (await denyHarness.read()).find(i => i.kind === 'tool_result'),
      ).toMatchObject({ status: 'denied' });
    },
  );

  it('sanitizes runtime load errors and non-string outputs without failing the run, and stops on abort', async () => {
    const h = await setupSkillsHarness({
      skills: [
        {
          id: 'broken-file',
          description: 'Throws with internal path',
          load: async () => {
            throw new Error('ENOENT: /secret/internal/path/SKILL.md');
          },
        },
        {
          id: 'bad-return',
          description: 'Returns non-string',
          load: (() => 42) as unknown as Skill['load'],
        },
      ],
      script: [
        [
          callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'broken-file' }),
          callTool('m2', LOAD_SKILL_TOOL_ID, { id: 'bad-return' }),
        ],
        [say('Handled gracefully.')],
      ],
    });

    const { outcome } = await h.execute();
    expect(outcome).toEqual({ status: 'completed' });
    const results = (await h.read()).filter(i => i.kind === 'tool_result');
    expect(results).toEqual([
      expect.objectContaining({
        status: 'error',
        message: 'Could not load skill broken-file.',
      }),
      expect.objectContaining({
        status: 'error',
        message: 'The skill returned invalid content.',
      }),
    ]);
    expect(JSON.stringify(results)).not.toContain('/secret/internal/path');

    const abortHarness = await setupSkillsHarness({
      skills: [
        {
          id: 'slow',
          description: 'Aborts cleanly',
          load: async ctx => {
            abortHarness.controller.abort();
            ctx.signal.throwIfAborted?.();
            return 'never';
          },
        },
      ],
      script: [[callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'slow' })]],
    });
    const aborted = await abortHarness.execute();
    expect(aborted.outcome).toEqual({ status: 'cancelled' });
  });

  it('respects maxToolCallsPerRun for load_skill', async () => {
    const load1 = jest.fn(async () => 'Body 1');
    const load2 = jest.fn(async () => 'Body 2');
    const h = await setupSkillsHarness({
      skills: [
        { id: 's1', description: 'Skill 1', load: load1 },
        { id: 's2', description: 'Skill 2', load: load2 },
      ],
      limits: { maxToolCallsPerRun: 1 },
      script: [
        [
          callTool('m1', LOAD_SKILL_TOOL_ID, { id: 's1' }),
          callTool('m2', LOAD_SKILL_TOOL_ID, { id: 's2' }),
        ],
        [say('Limit hit.')],
      ],
    });
    const { outcome } = await h.execute();
    expect(outcome).toEqual({
      status: 'completed',
      endReason: 'max_tool_calls',
    });
    expect(load1).toHaveBeenCalledTimes(1);
    expect(load2).not.toHaveBeenCalled();
    const results = (await h.read()).filter(i => i.kind === 'tool_result');
    expect(results).toEqual([
      expect.objectContaining({ status: 'denied', message: 'tool call limit' }),
      expect.objectContaining({
        status: 'ok',
        output: expect.objectContaining({ id: 's1', content: 'Body 1' }),
      }),
    ]);
  });

  it('lets a beforeToolCall hook deny load_skill without calling load()', async () => {
    const load = jest.fn(async () => 'Skill body');
    const beforeToolCall = jest.fn(() => ({
      action: 'deny' as const,
      reason: 'Skills are off today.',
    }));
    const h = await setupSkillsHarness({
      skills: [{ id: 'known', description: 'Known skill', load }],
      hooks: { beforeToolCall: [beforeToolCall] },
      script: [
        [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'known' })],
        [say('Denied by the hook.')],
      ],
    });

    const { outcome } = await h.execute();
    expect(outcome).toEqual({ status: 'completed' });
    expect(beforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: LOAD_SKILL_TOOL_ID,
        input: { id: 'known' },
        readOnly: true,
      }),
      expect.objectContaining({ agentId: 'default', step: 1 }),
    );
    expect(load).not.toHaveBeenCalled();
    expect((await h.read()).find(i => i.kind === 'tool_result')).toMatchObject({
      status: 'denied',
      message: 'Skills are off today.',
    });
  });

  it('passes the load_skill result through afterToolCall hooks', async () => {
    const h = await setupSkillsHarness({
      skills: [{ id: 'known', description: 'Known skill', load: () => 'Body' }],
      hooks: {
        afterToolCall: [
          (_call, result) => ({ ...result, output: { replaced: true } }),
        ],
      },
      script: [
        [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'known' })],
        [say('Done.')],
      ],
    });

    await h.execute();
    expect((await h.read()).find(i => i.kind === 'tool_result')).toMatchObject({
      status: 'ok',
      output: { replaced: true },
    });
  });

  it('lets a beforeToolCall hook make load_skill wait for an approval', async () => {
    const load = jest.fn(async () => 'Skill body');
    const h = await setupSkillsHarness({
      skills: [{ id: 'known', description: 'Known skill', load }],
      hooks: { beforeToolCall: [() => ({ action: 'ask' as const })] },
      script: [
        [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'known' })],
        [say('Loaded after approval.')],
      ],
    });

    const { outcome } = await h.execute();
    expect(outcome.status).toBe('waiting_approval');
    expect(load).not.toHaveBeenCalled();
    expect((await h.read()).find(i => i.kind === 'tool_call')).toMatchObject({
      toolId: LOAD_SKILL_TOOL_ID,
      policy: 'ask',
    });
  });

  it('stops waiting for a load() that never answers when the run is stopped', async () => {
    const h = await setupSkillsHarness({
      skills: [
        {
          id: 'stuck',
          description: 'Never answers',
          load: () => {
            setTimeout(() => h.controller.abort(), 0);
            return new Promise<string>(() => {});
          },
        },
      ],
      script: [[callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'stuck' })]],
    });

    const { outcome } = await h.execute();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect((await h.read()).filter(i => i.kind === 'tool_result')).toEqual([]);
  });

  it('gives load() a copy of the principal', async () => {
    const seen: unknown[] = [];
    const h = await setupSkillsHarness({
      skills: [
        {
          id: 'mutating',
          description: 'Changes its context',
          load: ctx => {
            seen.push({ ...(ctx.principal as object) });
            (ctx.principal as { user: string }).user = 'user:changed';
            return 'Body';
          },
        },
      ],
      script: [
        [
          callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'mutating' }),
          callTool('m2', LOAD_SKILL_TOOL_ID, { id: 'mutating' }),
        ],
        [say('Done.')],
      ],
    });

    await h.execute();
    // The second call sees the principal of the run, not what the first changed.
    expect(seen).toEqual([{ user: 'user:a' }, { user: 'user:a' }]);
  });
});
