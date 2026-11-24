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

import { LeaseLost } from '@kwkevinchan/ai-chat-harness';
import { RunAlreadyActive, RunNotFound } from '../../domain';
import {
  CONSTRAINT_ERROR,
  NEW_SESSION,
  createPersistence,
  databaseErrorOf,
} from './__testUtils__';

describe('KnexRunRepository', () => {
  let p: Awaited<ReturnType<typeof createPersistence>>;
  let sessionId: string;

  beforeEach(async () => {
    p = await createPersistence();
    sessionId = (await p.sessions.create(NEW_SESSION)).id;
  });

  afterEach(async () => {
    await p.cleanup();
  });

  describe('start', () => {
    it('makes a running run that this backend holds', async () => {
      const run = await p.runs.start(sessionId);
      expect(run).toMatchObject({
        sessionId,
        status: 'running',
        leaseOwner: 'backend-a',
        cancelRequested: false,
        usage: { stepsUsed: 0, toolCallsUsed: 0, elapsedSeconds: 0 },
        fence: { runId: run.id, leaseOwner: 'backend-a' },
      });
      expect(run.leaseExpiresAt).toBe('2026-01-01T00:00:30.000Z');
      expect(await p.runs.get(run.id)).toEqual(
        (({ fence: _fence, ...rest }) => rest)(run),
      );
      expect(await p.runs.findActive(sessionId)).toMatchObject({ id: run.id });
    });

    it('refuses a second run while the first one is running or waits for an approval (H-03)', async () => {
      const run = await p.runs.start(sessionId);
      await expect(p.runs.start(sessionId)).rejects.toBeInstanceOf(
        RunAlreadyActive,
      );
      await p.runs.transition(run.id, 'waiting_approval');
      await expect(p.runs.start(sessionId)).rejects.toMatchObject({
        code: 'RUN_ALREADY_ACTIVE',
        sessionId,
      });
    });

    it('lets only one of several callers at the same time start a run (H-03)', async () => {
      const backends = ['backend-a', 'backend-b', 'backend-c'].map(name =>
        p.runsOf(name),
      );
      const results = await Promise.allSettled(
        Array.from({ length: 9 }, (_v, i) => backends[i % 3].start(sessionId)),
      );
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const reasons = results.flatMap(r =>
        r.status === 'rejected' ? [r.reason] : [],
      );
      expect(reasons).toHaveLength(8);
      expect(reasons.every(reason => reason instanceof RunAlreadyActive)).toBe(
        true,
      );
      expect(
        await p.knex('runs').where({ session_id: sessionId }),
      ).toHaveLength(1);
    });

    it('allows a new run once the run before has ended, and runs of other sessions at the same time', async () => {
      const run = await p.runs.start(sessionId);
      const other = await p.sessions.create(NEW_SESSION);
      await expect(p.runs.start(other.id)).resolves.toBeDefined();
      await p.runs.transition(run.id, 'completed', { endReason: 'done' });
      const next = await p.runs.start(sessionId, { parentRunId: run.id });
      expect(next).toMatchObject({ parentRunId: run.id, status: 'running' });
      expect(next.id).not.toBe(run.id);
    });

    it('does not make a run for a session that does not exist', async () => {
      await expect(
        databaseErrorOf(p.runs.start('no-such-session')),
      ).resolves.toMatch(CONSTRAINT_ERROR);
    });
  });

  describe('heartbeat and usage', () => {
    it('renews the lease and tells whether the user asked to stop', async () => {
      const run = await p.runs.start(sessionId);
      p.clock.advance(20);
      expect(await p.runs.heartbeat(run.fence)).toEqual({
        cancelRequested: false,
      });
      expect((await p.runs.get(run.id)).leaseExpiresAt).toBe(
        '2026-01-01T00:00:50.000Z',
      );
      expect(await p.runs.requestCancel(run.id)).toBe(true);
      expect(await p.runs.heartbeat(run.fence)).toEqual({
        cancelRequested: true,
      });
    });

    it('stores the usage, with a fraction of a second', async () => {
      const run = await p.runs.start(sessionId);
      await p.runs.recordUsage(run.fence, {
        stepsUsed: 3,
        toolCallsUsed: 2,
        elapsedSeconds: 12.345678,
      });
      expect((await p.runs.get(run.id)).usage).toEqual({
        stepsUsed: 3,
        toolCallsUsed: 2,
        elapsedSeconds: 12.345678,
      });
    });

    it('throws LeaseLost for an owner that does not hold the lease', async () => {
      const run = await p.runs.start(sessionId);
      const stale = { runId: run.id, leaseOwner: 'backend-b' };
      await expect(p.runs.heartbeat(stale)).rejects.toBeInstanceOf(LeaseLost);
      await expect(
        p.runs.recordUsage(stale, {
          stepsUsed: 1,
          toolCallsUsed: 1,
          elapsedSeconds: 1,
        }),
      ).rejects.toBeInstanceOf(LeaseLost);
      expect((await p.runs.get(run.id)).usage.stepsUsed).toBe(0);
    });

    it('throws LeaseLost after the run has ended or waits for an approval', async () => {
      const run = await p.runs.start(sessionId);
      await p.runs.transition(run.id, 'waiting_approval');
      await expect(p.runs.heartbeat(run.fence)).rejects.toBeInstanceOf(
        LeaseLost,
      );
    });
  });

  describe('acquireLease', () => {
    it('refuses while another backend holds a live lease', async () => {
      const run = await p.runs.start(sessionId);
      p.clock.advance(29);
      expect(await p.runsOf('backend-b').acquireLease(run.id)).toBeUndefined();
      expect((await p.runs.get(run.id)).leaseOwner).toBe('backend-a');
    });

    it('takes an expired lease, and the old owner loses it', async () => {
      const run = await p.runs.start(sessionId);
      p.clock.advance(31);
      const taken = await p.runsOf('backend-b').acquireLease(run.id);
      expect(taken).toMatchObject({
        status: 'running',
        leaseOwner: 'backend-b',
        fence: { runId: run.id, leaseOwner: 'backend-b' },
      });
      await expect(p.runs.heartbeat(run.fence)).rejects.toBeInstanceOf(
        LeaseLost,
      );
    });

    it('resumes a run that waits for an approval, for one of several callers at the same time', async () => {
      const run = await p.runs.start(sessionId);
      await p.runs.transition(run.id, 'waiting_approval');
      const results = await Promise.all(
        ['backend-a', 'backend-b', 'backend-c', 'backend-d'].map(name =>
          p.runsOf(name).acquireLease(run.id),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const held = await p.runs.get(run.id);
      expect(held.status).toBe('running');
      expect(results.find(Boolean)?.fence.leaseOwner).toBe(held.leaseOwner);
    });

    it('refuses a run that has ended', async () => {
      const run = await p.runs.start(sessionId);
      await p.runs.transition(run.id, 'failed', { endReason: 'error' });
      expect(await p.runs.acquireLease(run.id)).toBeUndefined();
    });
  });

  describe('transition', () => {
    it('ends the run: status, reason, time, and no lease or active session', async () => {
      const run = await p.runs.start(sessionId);
      p.clock.advance(5);
      const ended = await p.runs.transition(run.id, 'completed', {
        leaseOwner: 'backend-a',
        endReason: 'done',
      });
      expect(ended).toMatchObject({
        status: 'completed',
        endReason: 'done',
        endedAt: '2026-01-01T00:00:05.000Z',
      });
      expect(ended.leaseOwner).toBeUndefined();
      expect(ended.leaseExpiresAt).toBeUndefined();
      const row = await p.knex('runs').where({ id: run.id }).first();
      expect(row.active_session_id).toBeNull();
      expect(await p.runs.findActive(sessionId)).toBeUndefined();
    });

    it('keeps the run active while it waits for an approval, without a lease', async () => {
      const run = await p.runs.start(sessionId);
      const waiting = await p.runs.transition(run.id, 'waiting_approval');
      expect(waiting.status).toBe('waiting_approval');
      expect(waiting.leaseOwner).toBeUndefined();
      expect(await p.runs.findActive(sessionId)).toMatchObject({ id: run.id });
    });

    it('throws LeaseLost when the owner given does not hold the run', async () => {
      const run = await p.runs.start(sessionId);
      await expect(
        p.runs.transition(run.id, 'completed', { leaseOwner: 'backend-b' }),
      ).rejects.toBeInstanceOf(LeaseLost);
      expect((await p.runs.get(run.id)).status).toBe('running');
    });

    it('refuses a change the status does not allow', async () => {
      const run = await p.runs.start(sessionId);
      await p.runs.transition(run.id, 'completed');
      await expect(
        p.runs.transition(run.id, 'cancelled'),
      ).rejects.toMatchObject({ code: 'INVALID_RUN_TRANSITION' });
    });

    it('throws RunNotFound for a run that does not exist', async () => {
      await expect(
        p.runs.transition('nope', 'completed'),
      ).rejects.toBeInstanceOf(RunNotFound);
      await expect(p.runs.get('nope')).rejects.toBeInstanceOf(RunNotFound);
    });
  });

  describe('requestCancel', () => {
    it('is false for a run that has ended', async () => {
      const run = await p.runs.start(sessionId);
      await p.runs.transition(run.id, 'completed');
      expect(await p.runs.requestCancel(run.id)).toBe(false);
      expect((await p.runs.get(run.id)).cancelRequested).toBe(false);
    });
  });

  describe('expireStale (H-04)', () => {
    it('marks the running runs whose lease has run out as expired, and frees the session', async () => {
      const stale = await p.runs.start(sessionId);
      const otherSession = await p.sessions.create(NEW_SESSION);
      p.clock.advance(20);
      const alive = await p.runs.start(otherSession.id);
      p.clock.advance(15);
      expect(await p.runs.expireStale()).toEqual([stale.id]);
      expect(await p.runs.get(stale.id)).toMatchObject({
        status: 'expired',
        endReason: 'lease_expired',
      });
      expect((await p.runs.get(alive.id)).status).toBe('running');
      await expect(p.runs.start(sessionId)).resolves.toBeDefined();
      expect(await p.runs.expireStale()).toEqual([]);
    });

    it('leaves a run that waits for an approval alone', async () => {
      const run = await p.runs.start(sessionId);
      await p.runs.transition(run.id, 'waiting_approval');
      p.clock.advance(3600);
      expect(await p.runs.expireStale()).toEqual([]);
    });
  });
});
