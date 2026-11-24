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
  type Clock,
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
  ListQueue,
  ListSessions,
  ListSessionTools,
  ListToolsets,
  QueueMessage,
  ReorderQueue,
  ResumeQueue,
  ResumeRun,
  RunSupervisor,
  SendMessage,
  StartNextQueued,
  UpdateQueuedMessage,
  UpdateSession,
  createAfterRun,
  type AfterRun,
  type RunSettings,
} from './application';
import type {
  AgentCatalog,
  AuditLog,
  Logger,
  QueuedMessageRepository,
  RunRepository,
  SessionRepository,
} from './application/ports';
import { DEFAULT_QUEUE_MAX_MESSAGES } from './domain';

/** The ports of the host: what the use cases and the supervisor run on. */
export type HostPorts = {
  items: ItemLog;
  sessions: SessionRepository;
  runs: RunRepository;
  queue: QueuedMessageRepository;
  agents: AgentCatalog;
  tools: ToolGateway;
  model: ModelClient;
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  settings: RunSettings;
  /** `aiChat.input.queue.maxMessages`; 5 by default. */
  queueMaxMessages?: number;
  /** How often the supervisor renews the lease of a run; 10 seconds by default. */
  heartbeatMs?: number;
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
  } = ports;
  const advance = new AdvanceRun({
    items,
    model: ports.model,
    tools: new AuditedToolGateway(ports.tools, audit, logger),
    run: runs,
    clock,
    ids: ports.ids,
    extensions: {},
  });
  // The supervisor calls `afterRun` for the queue, and the queue starts runs
  // on the supervisor: the function is set once both exist.
  const afterRun: { current?: AfterRun } = {};
  const supervisor = new RunSupervisor({
    advance,
    runs,
    logger,
    heartbeatMs: ports.heartbeatMs,
    afterRun: info => afterRun.current!(info),
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
      getSession: new GetSession({ sessions, runs, items, queue }),
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
      insertMessage: new InsertMessage({ sessions, items }),
      queueMessage: new QueueMessage({
        sessions,
        queue,
        maxMessages: ports.queueMaxMessages ?? DEFAULT_QUEUE_MAX_MESSAGES,
      }),
      updateQueuedMessage: new UpdateQueuedMessage({ sessions, queue }),
      deleteQueuedMessage: new DeleteQueuedMessage({ sessions, queue }),
      reorderQueue: new ReorderQueue({ sessions, queue, runs }),
      listQueue: new ListQueue({ sessions, queue, runs }),
      resumeQueue: new ResumeQueue({ sessions, startNext }),
      followSession: new FollowSession({ sessions, runs, items, supervisor }),
      listToolsets: new ListToolsets({ agents }),
      listSessionTools: new ListSessionTools({ sessions, tools: ports.tools }),
      expireStaleRuns: new ExpireStaleRuns({ runs, logger }),
    },
  };
}
