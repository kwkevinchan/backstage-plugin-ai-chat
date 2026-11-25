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
  GetSession,
  InsertMessage,
  InsertQueuedMessage,
  ListQueue,
  ListSessions,
  ListSessionTools,
  ListToolsets,
  NameSession,
  PurgeExpiredSessions,
  PurgeUnusedAttachments,
  QueueMessage,
  ReadAttachment,
  ReorderQueue,
  ResumeQueue,
  ResumeRun,
  RunSupervisor,
  SendMessage,
  StartNextQueued,
  UpdateQueuedMessage,
  UpdateSession,
  UploadAttachment,
  createAfterRun,
  type AfterRun,
  type ImageSettings,
  type RunSettings,
} from './application';
import type {
  AccessControl,
  AgentCatalog,
  AttachmentStore,
  AuditLog,
  Logger,
  QueuedMessageRepository,
  RunRepository,
  SessionRepository,
  ShareRepository,
} from './application/ports';
import {
  DEFAULT_IMAGE_LIMITS,
  DEFAULT_INSERT_MAX_PER_RUN,
  DEFAULT_QUEUE_MAX_MESSAGES,
  DEFAULT_RETENTION_DAYS,
} from './domain';

/** The ports of the host: what the use cases and the supervisor run on. */
export type HostPorts = {
  items: ItemLog;
  sessions: SessionRepository;
  runs: RunRepository;
  queue: QueuedMessageRepository;
  agents: AgentCatalog;
  attachments: AttachmentStore;
  shares: ShareRepository;
  access: AccessControl;
  tools: ToolGateway;
  model: ModelClient;
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
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
   * Registrations from backend modules. The loop receives them and does not
   * call them yet. Omitted means nothing was registered.
   */
  extensions?: Extensions;
  /**
   * `aiChat.retention.days`. Sessions last changed longer ago than this are
   * deleted. 0 keeps every session. Defaults to 90.
   */
  retentionDays?: number;
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
  } = ports;
  const images: ImageSettings = ports.images ?? {
    ...DEFAULT_IMAGE_LIMITS,
    enabled: false,
  };
  const advance = new AdvanceRun({
    items,
    model: ports.model,
    tools: new AuditedToolGateway(ports.tools, audit, logger),
    run: runs,
    clock,
    ids: ports.ids,
    extensions: ports.extensions ?? emptyExtensions(),
  });
  // The supervisor calls `afterRun` for the queue, and the queue starts runs
  // on the supervisor: the function is set once both exist.
  const afterRun: { current?: AfterRun } = {};
  const nameSession = new NameSession({
    sessions,
    runs,
    items,
    model: ports.model,
    logger,
  });
  const supervisor = new RunSupervisor({
    advance,
    runs,
    logger,
    heartbeatMs: ports.heartbeatMs,
    afterRun: info => afterRun.current!(info),
    nameSession: info => nameSession.execute(info),
  });
  const startNext = new StartNextQueued({
    sessions,
    runs,
    queue,
    supervisor,
    agents,
    audit,
    clock,
    settings,
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
      createSession: new CreateSession({ sessions, agents }),
      getSession: new GetSession({
        sessions,
        runs,
        items,
        queue,
        shares,
        access,
        clock,
      }),
      listSessions: new ListSessions({ sessions }),
      updateSession: new UpdateSession({ sessions, agents }),
      deleteSession: new DeleteSession({ sessions, runs }),
      sendMessage: new SendMessage({
        sessions,
        runs,
        items,
        supervisor,
        agents,
        clock,
        settings,
        attachments,
        images,
      }),
      decideApproval: new DecideApproval({
        sessions,
        runs,
        items,
        supervisor,
        agents,
        audit,
        clock,
        settings,
      }),
      resumeRun: new ResumeRun({
        sessions,
        runs,
        items,
        supervisor,
        agents,
        clock,
        settings,
      }),
      cancelRun: new CancelRun({ sessions, runs, supervisor }),
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
      followSession: new FollowSession({ sessions, runs, items, supervisor }),
      listToolsets: new ListToolsets({ agents }),
      listSessionTools: new ListSessionTools({ sessions, tools: ports.tools }),
      uploadAttachment: new UploadAttachment({ sessions, attachments, images }),
      readAttachment: new ReadAttachment({ sessions, attachments }),
      purgeUnusedAttachments: new PurgeUnusedAttachments({
        attachments,
        clock,
      }),
      purgeExpiredSessions: new PurgeExpiredSessions({
        sessions,
        clock,
        retentionDays: ports.retentionDays ?? DEFAULT_RETENTION_DAYS,
      }),
      expireStaleRuns: new ExpireStaleRuns({ runs, logger }),
    },
  };
}
