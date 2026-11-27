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
  AdvanceRun,
  emptyExtensions,
  type Clock,
  type Extensions,
  type IdGenerator,
  type ItemLog,
  type ModelClient,
  type ToolGateway,
} from '@kwkevinchan/ai-chat-harness';
import {
  AuditedToolGateway,
  CancelRun,
  CreateSession,
  DecideApproval,
  DeleteQueuedMessage,
  DeleteSession,
  ExpireStaleRuns,
  FollowSession,
  ForkSession,
  GetSession,
  InsertMessage,
  InsertQueuedMessage,
  ListQueue,
  ListSessions,
  ListSessionTools,
  ListShares,
  ListToolsets,
  NameSession,
  PurgeExpiredSessions,
  PurgeUnusedAttachments,
  QueueMessage,
  ReadAttachment,
  ReorderQueue,
  ResumeQueue,
  ResumeRun,
  RevokeShare,
  RunSupervisor,
  RunTelemetry,
  SendMessage,
  ShareSession,
  StartNextQueued,
  UpdateQueuedMessage,
  UpdateSession,
  UpdateShare,
  UploadAttachment,
  createAfterRun,
  createRunEnded,
  DEFAULT_MODEL_ID,
  HostModelClient,
  ModelCatalog,
  type AfterRun,
  type ImageSettings,
  type RunSettings,
} from './application';
import {
  NoopMetrics,
  NoopNotifier,
  type AccessControl,
  type AgentCatalog,
  type AttachmentStore,
  type AuditLog,
  type EntityReader,
  type Logger,
  type Metrics,
  type ModelCallLimiter,
  type Notifier,
  type QueuedMessageRepository,
  type RunRepository,
  type SessionPreviewReader,
  type SessionRepository,
  type ShareRepository,
} from './application/ports';
import {
  DEFAULT_IMAGE_LIMITS,
  DEFAULT_INSERT_MAX_PER_RUN,
  DEFAULT_LIVE_SHARE_LIMITS,
  DEFAULT_QUEUE_MAX_MESSAGES,
  DEFAULT_RETENTION_DAYS,
  type LiveShareLimits,
} from './domain';

/** The ports of the host: what the use cases and the supervisor run on. */
export type HostPorts = {
  items: ItemLog & SessionPreviewReader;
  sessions: SessionRepository;
  runs: RunRepository;
  queue: QueuedMessageRepository;
  agents: AgentCatalog;
  /**
   * The catalog, read as the user: a session is bound only to an entity the
   * user can read (SE-02), and the built-in context provider `entity` reads
   * it at every step.
   */
  entities: EntityReader;
  attachments: AttachmentStore;
  shares: ShareRepository;
  access: AccessControl;
  tools: ToolGateway;
  /** The client of the model `default` (`aiChat.llm`). */
  model: ModelClient;
  /**
   * The clients of the other models, by id: `aiChat.models` and the clients
   * of modules (X-09). An agent names one with `model`.
   */
  models?: ReadonlyMap<string, ModelClient>;
  /**
   * The rate limit of the models that have one (`requestsPerMinute`, P-06),
   * shared by the backends through `limiter`. `sleep` waits for the next
   * minute; a timer by default.
   */
  rateLimits?: {
    limiter: ModelCallLimiter;
    requestsPerMinute: ReadonlyMap<string, number>;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  };
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** Where the measurements of the runs go (O-01); nowhere when not given. */
  metrics?: Metrics;
  settings: RunSettings;
  /** `aiChat.input.queue.maxMessages`; 5 by default. */
  queueMaxMessages?: number;
  /** `aiChat.input.insert.maxPerRun`; 5 by default. */
  insertMaxPerRun?: number;
  /**
   * The limits on images and whether the model reads them
   * (`aiChat.input.images`, `aiChat.llm.images`). Images are off, with the
   * default limits, when not given.
   */
  images?: ImageSettings;
  /** How often the supervisor renews the lease of a run; 10 seconds by default. */
  heartbeatMs?: number;
  /**
   * Tells the owner when a run starts, waits, completes, or ends without an
   * answer. Defaults to a notifier that does nothing.
   */
  notifier?: Notifier;
  /**
   * Registrations from backend modules. The loop calls the hooks before and
   * after the steps; the supervisor and `CancelRun` call `onRunEnd`. Omitted
   * means nothing was registered.
   */
  extensions?: Extensions;
  /**
   * `aiChat.retention.days`. Sessions last changed longer ago than this are
   * deleted. 0 keeps every session. Defaults to 90.
   */
  retentionDays?: number;
  /** `aiChat.sharing.live`; on, 24 hours, at most 72 when not given. */
  liveShares?: LiveShareLimits;
};

/**
 * Wires the loop of the core, the supervisor and the use cases of the host
 * on the ports. Every tool that is not read-only is audited when it runs
 * (O-02). `plugin.ts` makes the adapters and calls this; so do the tests.
 */
export function createHost(ports: HostPorts) {
  const {
    items,
    sessions,
    runs,
    queue,
    agents,
    audit,
    clock,
    logger,
    settings,
    attachments,
    shares,
    access,
    entities,
  } = ports;
  const images: ImageSettings = ports.images ?? {
    ...DEFAULT_IMAGE_LIMITS,
    enabled: false,
  };
  const extensions = ports.extensions ?? emptyExtensions();
  const live = ports.liveShares ?? DEFAULT_LIVE_SHARE_LIMITS;
  if (ports.models?.has(DEFAULT_MODEL_ID)) {
    throw new Error(`The model ${DEFAULT_MODEL_ID} is the one of \`model\``);
  }
  const rateLimits = ports.rateLimits;
  const telemetry = new RunTelemetry(
    ports.metrics ?? new NoopMetrics(),
    logger,
  );
  const models = new ModelCatalog(
    new Map(
      [
        [DEFAULT_MODEL_ID, ports.model] as const,
        ...(ports.models ?? new Map<string, ModelClient>()),
      ].map(([modelId, client]) => {
        const perMinute = rateLimits?.requestsPerMinute.get(modelId);
        return [
          modelId,
          new HostModelClient(client, {
            modelId,
            attachments,
            clock,
            ...(rateLimits &&
              perMinute !== undefined && {
                rate: { limiter: rateLimits.limiter, perMinute },
              }),
            ...(rateLimits?.sleep && { sleep: rateLimits.sleep }),
            telemetry,
          }),
        ];
      }),
    ),
  );
  const advance = new AdvanceRun({
    items,
    tools: new AuditedToolGateway(ports.tools, audit, logger),
    run: runs,
    clock,
    ids: ports.ids,
    extensions,
    observer: telemetry,
  });
  // The supervisor calls `afterRun` for the queue, and the queue starts runs
  // on the supervisor: the function is set once both exist.
  const afterRun: { current?: AfterRun } = {};
  const notifier = ports.notifier ?? new NoopNotifier();
  const notify = (
    sessionId: string,
    activity: Parameters<Notifier['notify']>[0]['activity'],
  ) =>
    sessions.get(sessionId).then(session =>
      notifier.notify({
        ownerRef: session.ownerRef,
        sessionId,
        activity,
      }),
    );
  const nameSession = new NameSession({
    sessions,
    runs,
    items,
    agents,
    models,
    logger,
    clock,
    telemetry,
  });
  const runEnded = createRunEnded({
    hooks: ports.extensions?.hooks?.onRunEnd ?? [],
    logger,
    telemetry,
  });
  const supervisor = new RunSupervisor({
    advance,
    runs,
    logger,
    runEnded,
    heartbeatMs: ports.heartbeatMs,
    afterRun: info => afterRun.current!(info),
    notify,
    nameSession: info => nameSession.execute(info),
  });
  const startNext = new StartNextQueued({
    sessions,
    runs,
    queue,
    supervisor,
    agents,
    models,
    audit,
    clock,
    settings,
    notify,
    logger,
  });
  afterRun.current = createAfterRun({
    queue,
    startNext,
    supervisor,
    clock,
    settings,
    logger,
  });
  return {
    supervisor,
    useCases: {
      createSession: new CreateSession({
        sessions,
        agents,
        entities,
        access,
      }),
      getSession: new GetSession({
        sessions,
        runs,
        items,
        queue,
        shares,
        access,
        clock,
      }),
      listSessions: new ListSessions({ sessions, runs, items }),
      updateSession: new UpdateSession({ sessions, agents, access }),
      deleteSession: new DeleteSession({ sessions, runs }),
      sendMessage: new SendMessage({
        sessions,
        runs,
        items,
        supervisor,
        agents,
        models,
        clock,
        settings,
        attachments,
        images,
        entities,
        notify,
        logger,
      }),
      decideApproval: new DecideApproval({
        sessions,
        runs,
        items,
        supervisor,
        agents,
        models,
        audit,
        clock,
        settings,
        notify,
        logger,
        runEnded,
      }),
      resumeRun: new ResumeRun({
        sessions,
        runs,
        items,
        supervisor,
        agents,
        models,
        clock,
        settings,
        notify,
        logger,
        runEnded,
      }),
      cancelRun: new CancelRun({
        sessions,
        runs,
        supervisor,
        notify,
        logger,
        runEnded,
      }),
      insertMessage: new InsertMessage({
        sessions,
        items,
        attachments,
        images,
      }),
      insertQueuedMessage: new InsertQueuedMessage({
        sessions,
        queue,
        maxInsertsPerRun: ports.insertMaxPerRun ?? DEFAULT_INSERT_MAX_PER_RUN,
        maxImageBytesPerInput: images.maxBytesPerInput,
      }),
      queueMessage: new QueueMessage({
        sessions,
        queue,
        maxMessages: ports.queueMaxMessages ?? DEFAULT_QUEUE_MAX_MESSAGES,
        attachments,
        images,
      }),
      updateQueuedMessage: new UpdateQueuedMessage({
        sessions,
        queue,
        attachments,
        images,
      }),
      deleteQueuedMessage: new DeleteQueuedMessage({ sessions, queue }),
      reorderQueue: new ReorderQueue({ sessions, queue, runs }),
      listQueue: new ListQueue({ sessions, queue, runs }),
      resumeQueue: new ResumeQueue({ sessions, startNext }),
      followSession: new FollowSession({
        sessions,
        runs,
        items,
        supervisor,
        shares,
        access,
        clock,
        logger,
      }),
      listShares: new ListShares({ sessions, shares, clock }),
      shareSession: new ShareSession({
        sessions,
        shares,
        items,
        audit,
        clock,
        ids: ports.ids,
        live,
      }),
      updateShare: new UpdateShare({
        sessions,
        shares,
        items,
        audit,
        clock,
        live,
      }),
      revokeShare: new RevokeShare({ sessions, shares, audit }),
      forkSession: new ForkSession({
        sessions,
        items,
        attachments,
        shares,
        access,
        agents,
        entities,
        audit,
        clock,
        ids: ports.ids,
      }),
      listToolsets: new ListToolsets({ agents, access }),
      listSessionTools: new ListSessionTools({
        sessions,
        tools: ports.tools,
        agents,
        skills: extensions.skills,
      }),
      uploadAttachment: new UploadAttachment({ sessions, attachments, images }),
      readAttachment: new ReadAttachment({
        sessions,
        attachments,
        shares,
        access,
        items,
        clock,
      }),
      purgeUnusedAttachments: new PurgeUnusedAttachments({
        attachments,
        clock,
      }),
      purgeExpiredSessions: new PurgeExpiredSessions({
        sessions,
        clock,
        retentionDays: ports.retentionDays ?? DEFAULT_RETENTION_DAYS,
      }),
      expireStaleRuns: new ExpireStaleRuns({
        runs,
        logger,
        notify,
        sessions,
        runEnded,
      }),
    },
  };
}
