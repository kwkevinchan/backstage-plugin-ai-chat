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

import {
  FakeClock,
  SequentialIdGenerator,
} from '@kwkevinchan/ai-chat-harness/testing';
import type { Knex } from 'knex';
import { KnexAttachmentStore } from '../adapters/persistence/KnexAttachmentStore';
import { KnexModelCallLimiter } from '../adapters/persistence/KnexModelCallLimiter';
import { KnexItemLog } from '../adapters/persistence/KnexItemLog';
import { KnexQueuedMessageRepository } from '../adapters/persistence/KnexQueuedMessageRepository';
import { KnexRunRepository } from '../adapters/persistence/KnexRunRepository';
import { KnexSessionRepository } from '../adapters/persistence/KnexSessionRepository';
import { InsertMessage } from '../application';
import {
  DEFAULT_IMAGE_LIMITS,
  InsertLimitReached,
  NoActiveRun,
  QueueFull,
  QueuedMessageNotFound,
  RunNotRunning,
  TooManyActiveRuns,
  TooManyImageBytes,
  SessionNotFound,
  TooManyPendingAttachments,
  UnknownAttachment,
  UnreadMessages,
  type AttachmentMeta,
  type LeasedRun,
} from '../domain';
import { IMAGES } from '../__testUtils__/images';
import { createMigratedDb } from '../__testUtils__';

/**
 * Two connections of PostgreSQL that work at the same time (V-10). SQLite has
 * one connection, and its transactions go one after the other, so there is
 * nothing to race; these tests run on the PostgreSQL service of the CI
 * (`BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING`) and are skipped
 * without it.
 *
 * What they check is the guarantee of the design (architecture, "Insert and
 * the end of a run" and "Database"): an insert and the end of a run, whichever
 * comes first, never lose a message; and the writes of one run take their
 * locks in one order, so none of them is chosen as the victim of a deadlock.
 * Each round of a test starts the two sides at the same time, and a few turns
 * of the event loop of difference decide which one is first.
 */
const onPostgres = Boolean(
  process.env.BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING,
);
const describePostgres = onPostgres ? describe : describe.skip;

const ROUNDS = 100;

const owner = {
  userRef: 'user:default/jane',
  ownershipRefs: ['user:default/jane'],
  credentials: {},
};

type Db = {
  knex: Knex;
  sessions: KnexSessionRepository;
  runs: KnexRunRepository;
  items: KnexItemLog;
  queue: KnexQueuedMessageRepository;
  insertMessage: InsertMessage;
  /** Inserts messages with images; the model reads images. */
  insertImages: InsertMessage;
  attachments: KnexAttachmentStore;
  clock: FakeClock;
};

/** Lets the other side start first or second. */
async function jitter(): Promise<void> {
  const turns = Math.floor(Math.random() * 4);
  for (let i = 0; i < turns; i++) await new Promise(r => setImmediate(r));
}

/** A session with a running run, its first message, and one answer that read it. */
async function runningRun(
  db: Db,
): Promise<{ sessionId: string; run: LeasedRun }> {
  const session = await db.sessions.create({
    ownerRef: owner.userRef,
    agentId: 'default',
  });
  const run = await db.runs.start(session.id);
  await db.items.append(
    session.id,
    [{ kind: 'user_message', text: 'go' }],
    run.fence,
  );
  await db.items.append(
    session.id,
    [{ kind: 'agent_message', text: 'answer', readUpToSeq: 1 }],
    run.fence,
  );
  return { sessionId: session.id, run };
}

async function readUpToSeqOf(db: Db, runId: string): Promise<number> {
  const row = await db
    .knex('runs')
    .where({ id: runId })
    .first('read_up_to_seq');
  return row.read_up_to_seq;
}

function insertText(db: Db, sessionId: string, runId: string, text: string) {
  return jitter().then(() =>
    db.insertMessage.execute({ principal: owner, sessionId, runId, text }),
  );
}

function endRun(db: Db, run: LeasedRun) {
  return jitter().then(() =>
    db.runs.transition(run.id, 'completed', {
      leaseOwner: run.fence.leaseOwner,
      requireAllRead: true,
    }),
  );
}

async function appendOutput(
  db: Db,
  sessionId: string,
  run: LeasedRun,
): Promise<void> {
  await jitter();
  const log = await db.items.read(sessionId);
  await db.items.append(
    sessionId,
    [
      {
        kind: 'agent_message',
        text: 'a',
        readUpToSeq: log[log.length - 1].seq,
      },
    ],
    run.fence,
  );
}

async function addToQueue(
  db: Db,
  sessionId: string,
  text: string,
  max: number,
) {
  await jitter();
  try {
    return await db.queue.add(sessionId, { text }, { max });
  } catch (error) {
    // A full queue is an answer, not a failure of the locks.
    if (error instanceof QueueFull) return undefined;
    throw error;
  }
}

/** The reasons of the calls that failed, as text: empty when none did. */
function failuresOf(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap(result =>
    result.status === 'rejected' ? [String(result.reason)] : [],
  );
}

describePostgres('two PostgreSQL connections at the same time (V-10)', () => {
  const db = {} as Db;

  beforeAll(async () => {
    db.knex = await createMigratedDb();
  });

  afterAll(async () => {
    await db.knex.destroy();
  });

  beforeEach(() => {
    const clock = new FakeClock();
    // Ids are unique across the tests: the database is shared.
    const ids = new SequentialIdGenerator(
      `r${Math.random().toString(36).slice(2, 8)}`,
    );
    db.sessions = new KnexSessionRepository(db.knex, clock, ids);
    // The tests share one owner and leave runs going on; the limit of runs per
    // user has its own test below.
    const unlimited = { runsPerUser: Number.MAX_SAFE_INTEGER };
    db.runs = new KnexRunRepository(db.knex, clock, ids, unlimited);
    db.items = new KnexItemLog(db.knex, clock, { maxInsertsPerRun: 1000 });
    db.queue = new KnexQueuedMessageRepository(db.knex, clock, ids, unlimited);
    db.clock = clock;
    db.attachments = new KnexAttachmentStore(db.knex, clock, ids);
    db.insertMessage = new InsertMessage({
      sessions: db.sessions,
      items: db.items,
      attachments: db.attachments,
      images: { ...DEFAULT_IMAGE_LIMITS, enabled: false },
    });
    db.insertImages = new InsertMessage({
      sessions: db.sessions,
      items: db.items,
      attachments: db.attachments,
      images: { ...DEFAULT_IMAGE_LIMITS, enabled: true },
    });
  });

  it('a delete waits for an append that holds the run, and then deletes the session, without a deadlock', async () => {
    const { sessionId, run } = await runningRun(db);
    let releaseAppend!: () => void;
    const hold = new Promise<void>(resolve => {
      releaseAppend = resolve;
    });
    let locked!: () => void;
    const hasRun = new Promise<void>(resolve => {
      locked = resolve;
    });
    // The order of an append: the run, then the session. It keeps the run
    // until it is released, so a delete that locked the session first would
    // be holding it and waiting for this run (a deadlock).
    const append = db.knex.transaction(async trx => {
      await trx('runs').where({ id: run.id }).forNoKeyUpdate();
      locked();
      await hold;
      await trx('sessions').where({ id: sessionId }).forUpdate();
    });
    await hasRun;

    let settled = false;
    const deleting = db.sessions.delete(sessionId).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    const raced = await Promise.race([
      deleting.then(() => 'finished' as const),
      new Promise<'waiting'>(resolve =>
        setTimeout(() => resolve('waiting'), 1500),
      ),
    ]);
    expect(raced).toBe('waiting');
    expect(settled).toBe(false);

    releaseAppend();
    await append;
    await deleting;
    await expect(db.sessions.get(sessionId)).rejects.toBeInstanceOf(
      SessionNotFound,
    );
  });

  it(`an insert and the end of the run at the same time, ${ROUNDS} rounds: each round, the message is written and the run goes on, or the run ended and the insert got RunNotRunning; no message is lost`, async () => {
    const rounds: {
      insertFirst: boolean;
      endedRefused: boolean;
      insertRefused: boolean;
      status: string;
      unread: number;
    }[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const { sessionId, run } = await runningRun(db);
      const [inserted, ended] = await Promise.allSettled([
        insertText(db, sessionId, run.id, `round ${round}`),
        endRun(db, run),
      ]);
      const row = await db.knex('runs').where({ id: run.id }).first();
      const unread = await db
        .knex('items')
        .where({ session_id: sessionId, run_id: run.id, kind: 'user_message' })
        .andWhere('seq', '>', row.read_up_to_seq);
      rounds.push({
        insertFirst: inserted.status === 'fulfilled',
        endedRefused:
          ended.status === 'rejected' && ended.reason instanceof UnreadMessages,
        insertRefused:
          inserted.status === 'rejected' &&
          inserted.reason instanceof RunNotRunning,
        status: row.status,
        unread: unread.length,
      });
    }
    // Insert first: the end was refused, the run goes on, one message waits.
    expect(
      rounds
        .filter(r => r.insertFirst)
        .every(r => r.endedRefused && r.status === 'running' && r.unread === 1),
    ).toBe(true);
    // End first: the insert saw it and wrote nothing.
    expect(
      rounds
        .filter(r => !r.insertFirst)
        .every(
          r => r.insertRefused && r.status === 'completed' && r.unread === 0,
        ),
    ).toBe(true);
    // A run that ended the normal way has no message beyond what was read.
    expect(
      rounds.filter(r => r.status === 'completed').every(r => r.unread === 0),
    ).toBe(true);
    expect(rounds).toHaveLength(ROUNDS);
  });

  it(`an insert and the output of a model call at the same time, ${ROUNDS} rounds: both finish, no deadlock, and runs.read_up_to_seq only goes up`, async () => {
    const { sessionId, run } = await runningRun(db);
    const marks = [await readUpToSeqOf(db, run.id)];
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const results = await Promise.allSettled([
        insertText(db, sessionId, run.id, `round ${round}`),
        appendOutput(db, sessionId, run),
      ]);
      failures.push(...failuresOf(results));
      marks.push(await readUpToSeqOf(db, run.id));
    }
    expect(failures).toEqual([]);
    expect(marks).toEqual([...marks].sort((a, b) => a - b));
    expect(marks[marks.length - 1]).toBeGreaterThan(marks[0]);
  });

  it(`a queued message and the output of a model call at the same time, ${ROUNDS} rounds: both finish, no deadlock, and runs.read_up_to_seq only goes up`, async () => {
    const { sessionId, run } = await runningRun(db);
    const marks = [await readUpToSeqOf(db, run.id)];
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const results = await Promise.allSettled([
        addToQueue(db, sessionId, `q${round}`, 3),
        appendOutput(db, sessionId, run),
      ]);
      failures.push(...failuresOf(results));
      marks.push(await readUpToSeqOf(db, run.id));
      // Keep room in the queue.
      await db
        .knex('queued_messages')
        .where({ session_id: sessionId })
        .delete();
    }
    expect(failures).toEqual([]);
    expect(marks).toEqual([...marks].sort((a, b) => a - b));
  });

  it('many inserts, queued messages and outputs at once: no deadlock, and the numbers of the items stay one after the other', async () => {
    const { sessionId, run } = await runningRun(db);
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      work.push(
        insertText(db, sessionId, run.id, `i${i}`),
        addToQueue(db, sessionId, `q${i}`, 1000),
        appendOutput(db, sessionId, run),
      );
    }
    const failures = failuresOf(await Promise.allSettled(work));
    expect(failures).toEqual([]);
    const seqs = (await db.items.read(sessionId)).map(item => item.seq);
    expect(seqs).toEqual(seqs.map((_seq, index) => index + 1));
  });

  it('two starts of the queue at the same time, 20 rounds: one run, one message sent', async () => {
    const sent: { started: number; left: string[] }[] = [];
    for (let round = 0; round < 20; round++) {
      const session = await db.sessions.create({
        ownerRef: owner.userRef,
        agentId: 'default',
      });
      const first = await db.runs.start(session.id);
      await db.queue.add(session.id, { text: 'a' }, { max: 5 });
      await db.queue.add(session.id, { text: 'b' }, { max: 5 });
      await db.runs.transition(first.id, 'completed');
      const started = await Promise.all([
        db.queue.startNext(session.id),
        db.queue.startNext(session.id),
        db.queue.startNext(session.id),
      ]);
      sent.push({
        started: started.filter(Boolean).length,
        left: (await db.queue.list(session.id)).map(m => m.text),
      });
    }
    expect(sent.every(r => r.started === 1 && r.left.join() === 'b')).toBe(
      true,
    );
  });

  it(`a queued message and the end of the run at the same time, ${ROUNDS} rounds: it is in the queue when the run ended, or it got NoActiveRun`, async () => {
    const rounds: { added: boolean; refused: boolean; inQueue: number }[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const { sessionId, run } = await runningRun(db);
      const [added, ended] = await Promise.allSettled([
        jitter().then(() => db.queue.add(sessionId, { text: 'q' }, { max: 5 })),
        endRun(db, run),
      ]);
      expect(ended.status).toBe('fulfilled');
      rounds.push({
        added: added.status === 'fulfilled',
        refused:
          added.status === 'rejected' && added.reason instanceof NoActiveRun,
        inQueue: (await db.queue.list(sessionId)).length,
      });
    }
    // Added: the message waits for the next start. Refused: nothing was left.
    expect(
      rounds.every(r =>
        r.added ? r.inQueue === 1 : r.refused && r.inQueue === 0,
      ),
    ).toBe(true);
  });
  describe('images (IN-03, IN-04, IN-06)', () => {
    const upload = (
      sessionId: string,
      maxPending = 100,
    ): Promise<AttachmentMeta> =>
      db.attachments.put({
        sessionId,
        ownerRef: owner.userRef,
        mediaType: 'image/png',
        name: 'a.png',
        bytes: IMAGES['image/png'],
        maxPending,
      });

    /** Makes the images a day old without moving the clock: the lease of the run stays live. */
    const age = (...ids: string[]) =>
      db
        .knex('attachments')
        .whereIn('id', ids)
        .update({ created_at: '2025-01-01T00:00:00.000Z' });

    const insertWith = (sessionId: string, runId: string, ids: string[]) =>
      jitter().then(() =>
        db.insertImages.execute({
          principal: owner,
          sessionId,
          runId,
          text: 'with images',
          attachmentIds: ids,
        }),
      );

    it(`the cleaning and an insert that uses the same old image at the same time, ${ROUNDS} rounds: the message is written and its image is there and marked, or the image was deleted and nothing was written`, async () => {
      const outcomes: { written: boolean; refused: boolean; ok: boolean }[] =
        [];
      for (let round = 0; round < ROUNDS; round++) {
        const { sessionId, run } = await runningRun(db);
        const image = await upload(sessionId);
        await age(image.id);
        const [inserted, purged] = await Promise.allSettled([
          insertWith(sessionId, run.id, [image.id]),
          // The insert takes several queries before it reaches the image, so
          // the cleaning is started after a random number of milliseconds:
          // sometimes before the insert holds the image, sometimes after.
          new Promise<void>(resolve =>
            setTimeout(resolve, Math.floor(Math.random() * 15)),
          ).then(() => db.attachments.purgeUnused(db.clock.now())),
        ]);
        expect(purged.status).toBe('fulfilled');
        const row = await db
          .knex('attachments')
          .where({ id: image.id })
          .first('used_seq');
        const messages = (await db.items.read(sessionId)).filter(
          item => item.kind === 'user_message' && item.attachments,
        );
        outcomes.push({
          written: inserted.status === 'fulfilled',
          refused:
            inserted.status === 'rejected' &&
            inserted.reason instanceof UnknownAttachment,
          // A message with the image: the image exists and says which message
          // used it. No message: the image may be there (unused) or deleted.
          ok:
            messages.length === 1
              ? row !== undefined && row.used_seq === messages[0].seq
              : messages.length === 0,
        });
      }
      expect(outcomes.every(o => o.ok && (o.written || o.refused))).toBe(true);
      expect(outcomes).toHaveLength(ROUNDS);
    });

    it('the cleaning does not wait for a transaction that holds an image, and does not delete it', async () => {
      const session = await db.sessions.create({
        ownerRef: owner.userRef,
        agentId: 'default',
      });
      const image = await upload(session.id);
      await age(image.id);
      let release!: () => void;
      const holding = new Promise<void>(resolve => {
        release = resolve;
      });
      let locked!: () => void;
      const hasLock = new Promise<void>(resolve => {
        locked = resolve;
      });
      const holder = db.knex.transaction(async trx => {
        await trx('attachments').where({ id: image.id }).forUpdate();
        locked();
        await holding;
      });
      await hasLock;

      // It must return while the row is locked: it skips the row.
      const deleted = await Promise.race([
        db.attachments.purgeUnused(db.clock.now()),
        new Promise<string>(resolve =>
          setTimeout(() => resolve('waited'), 3000),
        ),
      ]);
      release();
      await holder;

      expect(deleted).toBe(0);
      expect(
        await db.knex('attachments').where({ id: image.id }).first('id'),
      ).toBeDefined();
    });

    it('inserts with images, queued messages with the same images, outputs and the cleaning at once: no deadlock, and every image of a message is marked', async () => {
      const { sessionId, run } = await runningRun(db);
      const images = [await upload(sessionId), await upload(sessionId)];
      const ids = images.map(i => i.id);
      await age(...ids);
      const expected = (reason: unknown) =>
        reason instanceof InsertLimitReached ||
        reason instanceof TooManyImageBytes ||
        reason instanceof QueueFull ||
        reason instanceof UnknownAttachment;
      const work: Promise<unknown>[] = [];
      for (let i = 0; i < 20; i++) {
        work.push(
          insertWith(sessionId, run.id, ids),
          jitter().then(() =>
            db.queue.add(
              sessionId,
              { text: `q${i}`, attachmentIds: ids },
              { max: 1000 },
            ),
          ),
          appendOutput(db, sessionId, run),
          jitter().then(() => db.attachments.purgeUnused(db.clock.now())),
        );
      }
      const results = await Promise.allSettled(work);
      const failures = results.flatMap(result =>
        result.status === 'rejected' && !expected(result.reason)
          ? [String(result.reason)]
          : [],
      );
      expect(failures).toEqual([]);
      const log = await db.items.read(sessionId);
      expect(log.map(item => item.seq)).toEqual(
        log.map((_s, index) => index + 1),
      );
      for (const item of log) {
        if (item.kind !== 'user_message' || !item.attachments) continue;
        for (const ref of item.attachments) {
          const row = await db
            .knex('attachments')
            .where({ id: ref.id })
            .first('used_seq');
          expect(row).toBeDefined();
          expect(row.used_seq).not.toBeNull();
        }
      }
    });

    it('two inserts with images that do not both fit, at the same time, 20 rounds: one is written, the other is refused', async () => {
      const kinds: string[] = [];
      for (let round = 0; round < 20; round++) {
        const { sessionId, run } = await runningRun(db);
        const limited = new KnexItemLog(db.knex, db.clock, {
          maxInsertsPerRun: 1000,
          maxImageBytesPerInput: IMAGES['image/png'].length * 3 - 1,
        });
        const insert = new InsertMessage({
          sessions: db.sessions,
          items: limited,
          attachments: db.attachments,
          images: { ...DEFAULT_IMAGE_LIMITS, enabled: true },
        });
        const a = await upload(sessionId);
        const b = await upload(sessionId);
        // The run holds one image; each insert alone fits, both do not.
        const first = await upload(sessionId);
        await limited.append(
          sessionId,
          [
            {
              kind: 'user_message',
              text: 'with image',
              delivery: 'inserted',
              attachments: [
                {
                  id: first.id,
                  mediaType: first.mediaType,
                  name: first.name,
                  size: first.size,
                },
              ],
            },
          ],
          { runId: run.id, leaseOwner: '' },
        );
        const results = await Promise.allSettled(
          [a, b].map(image =>
            jitter().then(() =>
              insert.execute({
                principal: owner,
                sessionId,
                runId: run.id,
                text: 'x',
                attachmentIds: [image.id],
              }),
            ),
          ),
        );
        kinds.push(
          results
            .map(r => {
              if (r.status === 'fulfilled') return 'written';
              return r.reason instanceof TooManyImageBytes
                ? 'refused'
                : String(r.reason);
            })
            .sort()
            .join(),
        );
      }
      expect(kinds.every(k => k === 'refused,written')).toBe(true);
    });

    it('lets in only the free places when uploads arrive at the same time', async () => {
      const session = await db.sessions.create({
        ownerRef: owner.userRef,
        agentId: 'default',
      });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => upload(session.id, 3)),
      );
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
      expect(
        results.every(
          r =>
            r.status === 'fulfilled' ||
            r.reason instanceof TooManyPendingAttachments,
        ),
      ).toBe(true);
    });
  });

  describe('insertQueuedMessage and startNext at the same time (IN-20)', () => {
    it(`turning a queued message into an insert vs endRun + startNext, ${ROUNDS} rounds: exactly one sends it, no deadlock`, async () => {
      const rounds: {
        insertFirst: boolean;
        insertRefused: boolean;
        ended: boolean;
        startedQueuedId: string | undefined;
        sentCount: number;
        sentDelivery: string | undefined;
        sentRunId: string | undefined;
        originalRunId: string;
        startedRunId: string | undefined;
        remainingIds: string[];
        q1Id: string;
        q2Id: string;
      }[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const { sessionId, run } = await runningRun(db);
        const q1 = await db.queue.add(
          sessionId,
          { text: `q1-${round}` },
          { max: 5 },
        );
        const q2 = await db.queue.add(
          sessionId,
          { text: `q2-${round}` },
          { max: 5 },
        );

        const [ins, endAndNext] = await Promise.allSettled([
          jitter().then(() => db.queue.insert(sessionId, q1.id, run.id)),
          jitter().then(async () => {
            try {
              await db.runs.transition(run.id, 'completed', {
                leaseOwner: run.fence.leaseOwner,
                requireAllRead: true,
              });
            } catch (err) {
              if (err instanceof UnreadMessages) {
                return { ended: false as const, started: undefined };
              }
              throw err;
            }
            const started = await db.queue.startNext(sessionId);
            return { ended: true as const, started };
          }),
        ]);

        expect(endAndNext.status).toBe('fulfilled');
        const side = (endAndNext as PromiseFulfilledResult<any>).value;
        const log = await db.items.read(sessionId);
        const sent = log.filter(
          i => i.kind === 'user_message' && i.text === `q1-${round}`,
        );
        const remaining = await db.queue.list(sessionId);
        rounds.push({
          insertFirst: ins.status === 'fulfilled',
          insertRefused:
            ins.status === 'rejected' && ins.reason instanceof RunNotRunning,
          ended: side.ended,
          startedQueuedId: side.started?.message.id,
          sentCount: sent.length,
          sentDelivery: (sent[0] as any)?.delivery,
          sentRunId: sent[0]?.runId,
          originalRunId: run.id,
          startedRunId: side.started?.run.id,
          remainingIds: remaining.map(m => m.id),
          q1Id: q1.id,
          q2Id: q2.id,
        });
      }
      expect(rounds).toHaveLength(ROUNDS);
      expect(
        rounds.every(
          r => r.sentCount === 1 && r.remainingIds.join(',') === r.q2Id,
        ),
      ).toBe(true);
      expect(
        rounds
          .filter(r => r.insertFirst)
          .every(
            r =>
              !r.ended &&
              r.sentDelivery === 'inserted' &&
              r.sentRunId === r.originalRunId,
          ),
      ).toBe(true);
      expect(
        rounds
          .filter(r => !r.insertFirst)
          .every(
            r =>
              r.insertRefused &&
              r.ended &&
              r.startedQueuedId === r.q1Id &&
              r.sentDelivery === 'queued' &&
              r.sentRunId === r.startedRunId,
          ),
      ).toBe(true);
    });

    it('two concurrent queue.insert calls for the same queuedId, 20 rounds: one wins, the other gets QueuedMessageNotFound', async () => {
      for (let round = 0; round < 20; round++) {
        const { sessionId, run } = await runningRun(db);
        const q = await db.queue.add(
          sessionId,
          { text: `dup-${round}` },
          { max: 5 },
        );
        const results = await Promise.allSettled([
          jitter().then(() => db.queue.insert(sessionId, q.id, run.id)),
          jitter().then(() => db.queue.insert(sessionId, q.id, run.id)),
        ]);
        const ok = results.filter(r => r.status === 'fulfilled');
        const fail = results.filter(r => r.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(fail).toHaveLength(1);
        expect((fail[0] as PromiseRejectedResult).reason).toBeInstanceOf(
          QueuedMessageNotFound,
        );
        const sent = (await db.items.read(sessionId)).filter(
          i => i.kind === 'user_message' && i.text === `dup-${round}`,
        );
        expect(sent).toHaveLength(1);
      }
    });
  });

  describe('expireStale (H-04)', () => {
    it('two backends at the same time get each stale run once, so the hooks of a run run once', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const session = await db.sessions.create({
          ownerRef: owner.userRef,
          agentId: 'default',
        });
        ids.push((await db.runs.start(session.id)).id);
      }
      db.clock.advance(31);

      const [a, b] = await Promise.all([
        db.runs.expireStale(),
        db.runs.expireStale(),
      ]);

      const returned = [...a, ...b].filter(id => ids.includes(id));
      expect(returned.sort()).toEqual([...ids].sort());
    });
  });

  describe('purgeExpired (SE-05)', () => {
    const age = (id: string) =>
      db
        .knex('sessions')
        .where({ id })
        .update({ updated_at: '2020-01-01T00:00:00.000Z' });

    async function oldSession(): Promise<string> {
      const session = await db.sessions.create({
        ownerRef: owner.userRef,
        agentId: 'default',
      });
      await age(session.id);
      return session.id;
    }

    it('two purges at the same time delete each expired session once', async () => {
      const ids = [];
      for (let i = 0; i < 20; i++) ids.push(await oldSession());
      const cutoff = db.clock.now();

      const [a, b] = await Promise.all([
        db.sessions.purgeExpired(cutoff),
        db.sessions.purgeExpired(cutoff),
      ]);

      expect(a + b).toBe(ids.length);
      expect(await db.knex('sessions').whereIn('id', ids)).toEqual([]);
    });

    it('does not wait for a transaction that holds a session, and does not delete it', async () => {
      const heldId = await oldSession();
      const freeId = await oldSession();
      let release!: () => void;
      const holding = new Promise<void>(resolve => {
        release = resolve;
      });
      let locked!: () => void;
      const hasLock = new Promise<void>(resolve => {
        locked = resolve;
      });
      const holder = db.knex.transaction(async trx => {
        await trx('sessions').where({ id: heldId }).forUpdate();
        locked();
        await holding;
      });
      await hasLock;

      const deleted = await Promise.race([
        db.sessions.purgeExpired(db.clock.now()),
        new Promise<string>(resolve =>
          setTimeout(() => resolve('waited'), 3000),
        ),
      ]);
      release();
      await holder;

      expect(deleted).toBe(1);
      await expect(db.sessions.get(heldId)).resolves.toBeDefined();
      await expect(db.sessions.get(freeId)).rejects.toBeInstanceOf(
        SessionNotFound,
      );
    });

    it('does not wait for a transaction that holds a run of the session, and does not delete it', async () => {
      // An earlier test leaves the session it was holding. That row is also
      // past the cutoff, and this call counts every session it deletes.
      await db
        .knex('sessions')
        .where('updated_at', '<', db.clock.now().toISOString())
        .delete();
      const session = await db.sessions.create({
        ownerRef: owner.userRef,
        agentId: 'default',
      });
      const run = await db.runs.start(session.id);
      await db.runs.transition(run.id, 'completed', {
        leaseOwner: run.fence.leaseOwner,
      });
      await age(session.id);
      let release!: () => void;
      const holding = new Promise<void>(resolve => {
        release = resolve;
      });
      let locked!: () => void;
      const hasLock = new Promise<void>(resolve => {
        locked = resolve;
      });
      const holder = db.knex.transaction(async trx => {
        await trx('runs').where({ id: run.id }).forUpdate();
        locked();
        await holding;
      });
      await hasLock;

      const deleted = await Promise.race([
        db.sessions.purgeExpired(db.clock.now()),
        new Promise<string>(resolve =>
          setTimeout(() => resolve('waited'), 3000),
        ),
      ]);
      release();
      await holder;

      expect(deleted).toBe(0);
      await expect(db.sessions.get(session.id)).resolves.toBeDefined();
    });
  });

  describe('runs per user and the rate limit of a model (P-05, P-06)', () => {
    it('four starts of one user at the same time, in four sessions, 20 rounds: exactly runsPerUser of them start', async () => {
      const clock = new FakeClock();
      const ids = new SequentialIdGenerator(
        `u${Math.random().toString(36).slice(2, 8)}`,
      );
      const runs = new KnexRunRepository(db.knex, clock, ids, {
        runsPerUser: 2,
      });
      const queue = new KnexQueuedMessageRepository(db.knex, clock, ids, {
        runsPerUser: 2,
      });
      for (let round = 0; round < 20; round++) {
        const ownerRef = `user:default/${ids.next()}`;
        const sessions = await Promise.all(
          [0, 1, 2, 3].map(() =>
            db.sessions.create({ ownerRef, agentId: 'default' }),
          ),
        );
        // Two sessions start from their queue, two from a message.
        for (const session of sessions.slice(2)) {
          const before = await db.runs.start(session.id);
          await db.queue.add(session.id, { text: 'queued' }, { max: 5 });
          await db.runs.transition(before.id, 'completed');
        }
        const results = await Promise.allSettled(
          sessions.map((session, i) =>
            jitter().then(
              (): Promise<unknown> =>
                i < 2 ? runs.start(session.id) : queue.startNext(session.id),
            ),
          ),
        );
        const started = results.filter(
          result => result.status === 'fulfilled' && result.value,
        );
        const refused = results.filter(
          result =>
            result.status === 'rejected' &&
            result.reason instanceof TooManyActiveRuns,
        );
        expect(started).toHaveLength(2);
        expect(refused).toHaveLength(2);
        const [{ count }] = await db
          .knex('runs')
          .join('sessions', 'sessions.id', 'runs.session_id')
          .where('sessions.owner_ref', ownerRef)
          .where('runs.status', 'running')
          .count({ count: '*' });
        expect(Number(count)).toBe(2);
      }
    });

    it('twenty calls of one model at the same time, 10 rounds: exactly requestsPerMinute of them get a turn', async () => {
      const limiter = new KnexModelCallLimiter(db.knex);
      const now = new Date('2026-01-01T00:00:30.000Z');
      for (let round = 0; round < 10; round++) {
        const modelId = `m${Math.random().toString(36).slice(2, 8)}`;
        const turns = await Promise.all(
          Array.from({ length: 20 }, () =>
            jitter().then(() => limiter.tryAcquire(modelId, 5, now)),
          ),
        );
        expect(turns.filter(turn => turn.acquired)).toHaveLength(5);
        expect(turns.find(turn => !turn.acquired)).toEqual({
          acquired: false,
          retryAt: new Date('2026-01-01T00:01:00.000Z'),
        });
      }
    });
  });

  describe('bindEntityIfUnbound (SE-02)', () => {
    it(`two bindings of one session at the same time, ${ROUNDS} rounds: exactly one is written, and it stays`, async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const session = await db.sessions.create({
          ownerRef: owner.userRef,
          agentId: 'default',
        });
        const bind = (ref: string) =>
          jitter().then(() => db.sessions.bindEntityIfUnbound(session.id, ref));
        const [a, b] = await Promise.all([
          bind('component:default/a'),
          bind('component:default/b'),
        ]);
        expect([a, b].filter(Boolean)).toHaveLength(1);
        expect((await db.sessions.get(session.id)).entityRef).toBe(
          a ? 'component:default/a' : 'component:default/b',
        );
      }
    });
  });
});
