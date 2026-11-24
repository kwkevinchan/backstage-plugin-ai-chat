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
import { OpenAiCompatibleModelClient } from './adapters/model/OpenAiCompatibleModelClient';
import {
  KnexItemLog,
  KnexRunRepository,
  KnexSessionRepository,
} from './adapters/persistence';
import { SystemClock, UuidGenerator } from './adapters/system';
import { ChatService } from './chat/ChatService';
import { readAiChatConfig } from './config';
import { ChatStore } from './database/ChatStore';
import { createHost } from './host';
import { OpenAiCompatibleClient } from './llm/OpenAiCompatibleClient';
import { createRouter } from './routes/router';

/** The size of the model input; it is not applied until the context budget is. */
const CONTEXT_BUDGET = { tokenBudget: 100_000, keepRecentSteps: 6 };

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

        // The runs of the new agent loop. No route uses them yet; the routes
        // still go to ChatService. The shutdown and the sweep of expired
        // leases already run.
        const clock = new SystemClock();
        const ids = new UuidGenerator();
        const items = new KnexItemLog(db, clock);
        const sessions = new KnexSessionRepository(db, clock, ids);
        const host = createHost({
          items,
          sessions,
          runs: new KnexRunRepository(db, clock, ids),
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
          settings: {
            limits: {
              maxSteps: aiChat.maxTurns,
              maxToolCallsPerRun: aiChat.maxToolCallsPerRun,
              runTimeoutSeconds: aiChat.runTimeoutSeconds,
            },
            budget: CONTEXT_BUDGET,
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

        const chat = new ChatService({
          store: new ChatStore(db),
          actions,
          llm: new OpenAiCompatibleClient(aiChat.llm),
          auditor,
          logger,
          config: aiChat,
        });
        httpRouter.use(createRouter({ httpAuth, chat, logger }));
        logger.info(
          `AI chat uses the model ${aiChat.llm.model} at ${aiChat.llm.baseUrl}`,
        );
      },
    });
  },
});
