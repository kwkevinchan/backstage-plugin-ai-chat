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
  coreServices,
  createBackendPlugin,
  resolvePackagePath,
} from '@backstage/backend-plugin-api';
import { actionsServiceRef } from '@backstage/backend-plugin-api/alpha';
import { ActionsToolGateway } from './adapters/backstage/ActionsToolGateway';
import { AuditorAuditLog } from './adapters/backstage/AuditorAuditLog';
import { ConfigAgentCatalog } from './adapters/backstage/ConfigAgentCatalog';
import { principalFromRequest } from './adapters/backstage/principalFromRequest';
import { createRouter } from './adapters/http';
import { OpenAiCompatibleClient } from './adapters/model/OpenAiCompatibleClient';
import { OpenAiCompatibleModelClient } from './adapters/model/OpenAiCompatibleModelClient';
import {
  KnexItemLog,
  KnexQueuedMessageRepository,
  KnexRunRepository,
  KnexSessionRepository,
} from './adapters/persistence';
import { SystemClock, UuidGenerator } from './adapters/system';
import { readAiChatConfig } from './config';
import { createHost } from './host';

/** How often the runs whose lease expired are marked `expired`. */
const EXPIRE_STALE_RUNS_EVERY = { seconds: 30 };

/**
 * Backend plugin of the AI chat. Serves the routes under `/api/ai-chat`: the
 * conversations of the signed-in user and the response streams. The model
 * calls the actions of the actions registry as that user; an action that is
 * not read-only runs only after the user allowed it in the chat. The
 * decisions and the invocations of such actions are recorded with the
 * auditor.
 *
 * @public
 */
export const aiChatPlugin = createBackendPlugin({
  pluginId: 'ai-chat',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        auditor: coreServices.auditor,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        auth: coreServices.auth,
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
        lifecycle: coreServices.lifecycle,
        scheduler: coreServices.scheduler,
        actions: actionsServiceRef,
      },
      async init({
        logger,
        config,
        auditor,
        httpAuth,
        userInfo,
        auth,
        httpRouter,
        database,
        lifecycle,
        scheduler,
        actions,
      }) {
        const aiChat = readAiChatConfig(config);
        // Reads and checks the toolsets and the policy, and warns about the
        // deprecated include and exclude lists.
        const catalog = new ConfigAgentCatalog(config, logger);
        const toolsets = await catalog.toolsets();
        logger.info(
          `AI chat toolsets: ${toolsets.map(t => t.id).join(', ') || 'none'}`,
        );
        const db = await database.getClient();
        if (!database.migrations?.skip) {
          await db.migrate.latest({
            directory: resolvePackagePath(
              '@kwkevinchan/backstage-plugin-ai-chat-backend',
              'migrations',
            ),
          });
        }

        const clock = new SystemClock();
        const ids = new UuidGenerator();
        const items = new KnexItemLog(db, clock, {
          maxInsertsPerRun: aiChat.input.insertMaxPerRun,
        });
        const sessions = new KnexSessionRepository(db, clock, ids);
        const host = createHost({
          items,
          sessions,
          runs: new KnexRunRepository(db, clock, ids),
          queue: new KnexQueuedMessageRepository(db, clock, ids),
          agents: catalog,
          tools: new ActionsToolGateway({
            actions,
            catalog,
            logger,
            // A session always stores its toolsets (CreateSession).
            enabledToolsets: async ctx =>
              (await sessions.get(ctx.sessionId)).enabledToolsets,
            maxOutputChars: aiChat.maxToolOutputChars,
          }),
          model: new OpenAiCompatibleModelClient(
            new OpenAiCompatibleClient(aiChat.llm),
          ),
          audit: new AuditorAuditLog(auditor),
          clock,
          ids,
          logger,
          queueMaxMessages: aiChat.input.queueMaxMessages,
          settings: {
            limits: {
              maxSteps: aiChat.maxTurns,
              maxToolCallsPerRun: aiChat.maxToolCallsPerRun,
              runTimeoutSeconds: aiChat.runTimeoutSeconds,
            },
            budget: aiChat.context,
          },
        });
        lifecycle.addShutdownHook(() => host.supervisor.shutdown());
        await scheduler.scheduleTask({
          id: 'ai-chat-expire-stale-runs',
          frequency: EXPIRE_STALE_RUNS_EVERY,
          timeout: { seconds: 30 },
          fn: async () => {
            await host.useCases.expireStaleRuns.execute();
          },
        });

        httpRouter.use(
          createRouter({
            principal: req =>
              principalFromRequest(req, { httpAuth, userInfo, auth }),
            useCases: host.useCases,
            logger,
          }),
        );
        logger.info(
          `AI chat uses the model ${aiChat.llm.model} at ${aiChat.llm.baseUrl}`,
        );
      },
    });
  },
});
