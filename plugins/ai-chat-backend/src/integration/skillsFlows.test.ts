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

import { LOAD_SKILL_TOOL_ID, type Skill } from '@kwkevinchan/ai-chat-harness';
import { callTool, say } from '@kwkevinchan/ai-chat-harness/testing';
import { createWorld, drain, jane } from './__testUtils__';

describe('skills flows through createHost and RunSupervisor (X-04)', () => {
  let world: Awaited<ReturnType<typeof createWorld>>;

  afterEach(async () => {
    await world?.cleanup();
  });

  it('presents metadata only in step context, loads skill lazily without approval on allow, and includes load_skill in listSessionTools', async () => {
    world = await createWorld({
      agents: {
        sre: {
          title: 'SRE',
          skills: ['deploy-failure'],
        },
        minimal: {
          title: 'Minimal',
          skills: [],
        },
      },
    });

    const deployLoad = jest.fn(async () => '# Full Deploy Guide\nCheck pods.');
    const otherLoad = jest.fn(async () => '# Other Secret');
    const skills: Skill[] = [
      {
        id: 'deploy-failure',
        description: 'Investigate failing deployments.',
        load: deployLoad,
      },
      {
        id: 'other-skill',
        description: 'Other skill.',
        load: otherLoad,
      },
    ];

    const b = world.backend(
      [
        [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'deploy-failure' })],
        [say('Checked the deploy runbook.')],
      ],
      { extensions: { skills } },
    );

    const sreSession = await world.newSession(jane, 'sre');
    const sreTools = await b.useCases.listSessionTools.execute({
      principal: jane,
      sessionId: sreSession.id,
    });
    expect(sreTools.map(t => t.id)).toContain(LOAD_SKILL_TOOL_ID);
    expect(sreTools.find(t => t.id === LOAD_SKILL_TOOL_ID)).toEqual({
      id: LOAD_SKILL_TOOL_ID,
      title: 'Load skill',
      description:
        'Load the full instructions for an available skill by its id.',
      readOnly: true,
    });

    const minimalSession = await world.newSession(jane, 'minimal');
    const minimalTools = await b.useCases.listSessionTools.execute({
      principal: jane,
      sessionId: minimalSession.id,
    });
    expect(minimalTools.map(t => t.id)).not.toContain(LOAD_SKILL_TOOL_ID);

    const handle = await b.useCases.sendMessage.execute({
      principal: jane,
      sessionId: sreSession.id,
      text: 'Why is deploy failing?',
    });
    const events = await drain(handle);
    expect(events[events.length - 1]).toMatchObject({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });

    expect(deployLoad).toHaveBeenCalledTimes(1);
    expect(otherLoad).not.toHaveBeenCalled();

    expect(b.model.inputs).toHaveLength(2);
    expect(b.model.inputs[0].system).toContain(
      '- deploy-failure: Investigate failing deployments.',
    );
    expect(b.model.inputs[0].system).not.toContain('other-skill');
    expect(b.model.inputs[0].system).not.toContain('Full Deploy Guide');

    expect(b.model.inputs[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          content: expect.stringContaining('Full Deploy Guide'),
        }),
      ]),
    );
  });

  it('rejects unlisted skill calls cleanly on scoped agents without halting the run', async () => {
    world = await createWorld({
      agents: {
        sre: {
          skills: ['deploy-failure'],
        },
      },
    });
    const otherLoad = jest.fn(async () => 'Secret body');
    const skills: Skill[] = [
      { id: 'deploy-failure', description: 'Deploy triage', load: () => 'ok' },
      { id: 'other-skill', description: 'Other', load: otherLoad },
    ];
    const b = world.backend(
      [
        [callTool('m1', LOAD_SKILL_TOOL_ID, { id: 'other-skill' })],
        [say('That skill is not available to this agent.')],
      ],
      { extensions: { skills } },
    );

    const session = await world.newSession(jane, 'sre');
    const handle = await b.useCases.sendMessage.execute({
      principal: jane,
      sessionId: session.id,
      text: 'Try loading other-skill',
    });
    const events = await drain(handle);
    expect(events[events.length - 1]).toMatchObject({
      type: 'run.ended',
      outcome: { status: 'completed' },
    });
    expect(otherLoad).not.toHaveBeenCalled();
    expect(
      (await world.items.read(session.id)).find(i => i.kind === 'tool_result'),
    ).toMatchObject({
      status: 'invalid',
      message: 'Unknown skill: other-skill',
    });
  });
});
