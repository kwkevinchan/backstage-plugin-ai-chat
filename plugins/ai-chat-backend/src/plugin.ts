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
import {
  actionsServiceRef,
  metricsServiceRef,
} from '@backstage/backend-plugin-api/alpha';
import { InputError } from '@backstage/errors';
import type { ModelClient } from '@kwkevinchan/ai-chat-harness';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { planContextProvider } from '@kwkevinchan/ai-chat-harness';
import { aiChatHarnessExtensionPoint } from '@kwkevinchan/backstage-plugin-ai-chat-node';
import { ActionsToolGateway } from './adapters/backstage/ActionsToolGateway';
import { AiChatHarnessRegistry } from './adapters/backstage/AiChatHarnessRegistry';
import { AuditorAuditLog } from './adapters/backstage/AuditorAuditLog';
import { BackstageMetrics } from './adapters/backstage/BackstageMetrics';
import { CatalogEntityReader } from './adapters/backstage/CatalogEntityReader';
import { ConfigAgentCatalog } from './adapters/backstage/ConfigAgentCatalog';
import { PermissionAccessControl } from './adapters/backstage/PermissionAccessControl';
import { principalFromRequest } from './adapters/backstage/principalFromRequest';
import { registerSessionAccess } from './adapters/backstage/sessionAccess';
import { registerToolsetAccess } from './adapters/backstage/toolsetAccess';
import { createRouter } from './adapters/http';
import { inputConfigOf } from './adapters/http/controllers/attachments';
import { OpenAiCompatibleClient } from './adapters/model/OpenAiCompatibleClient';
import { OpenAiCompatibleModelClient } from './adapters/model/OpenAiCompatibleModelClient';
import { limitSkillContent } from './adapters/skills/limitSkillContent';
import {
  loadSkillsFromDirectories,
  mergeSkills,
} from './adapters/skills/loadSkillDirectories';
import {
  assertSingleSqliteConnection,
  KnexAttachmentStore,
  KnexItemLog,
  KnexModelCallLimiter,
  KnexQueuedMessageRepository,
  KnexRunRepository,
  KnexSessionRepository,
  KnexShareRepository,
  KnexWriteQuota,
} from './adapters/persistence';
import { SystemClock, UuidGenerator } from './adapters/system';
import { readAiChatConfig, type ModelSettings } from './config';
import {
  DEFAULT_MODEL_ID,
  ToolsetScope,
  entityContextProvider,
  userContextProvider,
} from './application';
import type { Principal } from './domain';
import { DelegatingNotifier } from './application/ports';
import { createHost } from './host';
import { aiChatSignalsExtensionPoint } from './signals';

/** How often the runs whose lease expired are marked `expired`. */
const EXPIRE_STALE_RUNS_EVERY = { seconds: 30 };

/** How often the images that no message uses are deleted (IN-04). */
const PURGE_ATTACHMENTS_EVERY = { hours: 1 };

/**
 * How often sessions past `aiChat.retention.days` are deleted (SE-05).
 * The same hour as the unused images: a day is the unit of the retention.
 */
const PURGE_EXPIRED_SESSIONS_EVERY = { hours: 1 };

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
    const notifier = new DelegatingNotifier();
    env.registerExtensionPoint(aiChatSignalsExtensionPoint, {
      setNotifier(next) {
        notifier.use(next);
      },
    });
    // Modules of this plugin run their init before this one, and they add to
    // the registry through the extension point. It has to exist before that.
    const harnessExtensions = new AiChatHarnessRegistry();
    env.registerExtensionPoint(aiChatHarnessExtensionPoint, harnessExtensions);
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
        metrics: metricsServiceRef,
        catalogService: catalogServiceRef,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
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
        metrics,
        catalogService,
        permissions,
        permissionsRegistry,
      }) {
        const aiChat = readAiChatConfig(config);
        const directorySkills = await loadSkillsFromDirectories(
          aiChat.skills.directories,
          logger,
        );
        const skills = mergeSkills(
          directorySkills,
          harnessExtensions.skills(),
        ).map(skill => limitSkillContent(skill, aiChat.maxToolOutputChars));
        const knownSkills = new Set(skills.map(skill => skill.id));
        const configuredModels = new Map<string, ModelSettings>([
          [DEFAULT_MODEL_ID, aiChat.llm],
          ...aiChat.models,
        ]);
        const moduleModels = harnessExtensions.modelClients();
        for (const id of moduleModels.keys()) {
          // A module adds models; it never replaces one of the configuration.
          if (configuredModels.has(id)) {
            throw new InputError(
              `model client ${id} is already defined in the configuration`,
            );
          }
        }
        const knownModels = new Set([
          ...configuredModels.keys(),
          ...moduleModels.keys(),
        ]);
        // Reads and checks the toolsets, the policy and the agents, and warns
        // about the deprecated include and exclude lists.
        const catalog = new ConfigAgentCatalog(
          config,
          logger,
          harnessExtensions.agents(),
          knownSkills,
          knownModels,
        );
        logger.info(
          `AI chat extensions: ${
            harnessExtensions.agents().length
          } agent(s), ${harnessExtensions.hookCount()} hook(s), ${
            skills.length
          } skill(s), ${
            moduleModels.size
          } model client(s), ${harnessExtensions.contextProviderCount()} context provider(s)`,
        );
        const toolsets = await catalog.toolsets();
        logger.info(
          `AI chat toolsets: ${toolsets.map(t => t.id).join(', ') || 'none'}`,
        );
        const db = await database.getClient();
        // SQLite has no row locks. More than one connection can fail a
        // transaction with SQLITE_BUSY instead of waiting in lock order.
        assertSingleSqliteConnection(db);
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
          maxImageBytesPerInput: aiChat.input.images.maxBytesPerInput,
        });
        const attachments = new KnexAttachmentStore(db, clock, ids);
        const entities = new CatalogEntityReader(catalogService);
        const sessions = new KnexSessionRepository(db, clock, ids);
        const shares = new KnexShareRepository(db, clock, ids);
        const authorizer = registerSessionAccess(permissionsRegistry, {
          sessions,
          shares,
        });
        const access = new PermissionAccessControl({
          permissions,
          authorizer,
          toolsetAuthorizer: registerToolsetAccess(permissionsRegistry, {
            agents: catalog,
          }),
        });
        const toolsetScope = new ToolsetScope({
          sessions,
          agents: catalog,
          access,
        });
        const clientOf = (settings: ModelSettings): ModelClient =>
          new OpenAiCompatibleModelClient(
            new OpenAiCompatibleClient(settings),
            {
              attachments,
              images: settings.images,
              parallelToolCalls: settings.parallelToolCalls,
              logger,
            },
          );
        const requestsPerMinute = new Map<string, number>();
        for (const [id, settings] of configuredModels) {
          if (settings.requestsPerMinute !== undefined) {
            requestsPerMinute.set(id, settings.requestsPerMinute);
          }
        }
        const host = createHost({
          items,
          sessions,
          runs: new KnexRunRepository(db, clock, ids, {
            runsPerUser: aiChat.runsPerUser,
          }),
          queue: new KnexQueuedMessageRepository(db, clock, ids, {
            runsPerUser: aiChat.runsPerUser,
          }),
          shares,
          access,
          attachments,
          entities,
          agents: catalog,
          tools: new ActionsToolGateway({
            actions,
            catalog,
            logger,
            enabledToolsets: ctx =>
              toolsetScope.offered({
                sessionId: ctx.sessionId,
                principal: ctx.principal as Principal,
              }),
            maxOutputChars: aiChat.maxToolOutputChars,
            toolOutput: aiChat.toolOutput,
            ...(aiChat.writesPerMinute !== undefined && {
              writeQuota: {
                quota: new KnexWriteQuota(db),
                perMinute: aiChat.writesPerMinute,
                clock,
              },
            }),
          }),
          model: clientOf(aiChat.llm),
          models: new Map([
            ...[...aiChat.models].map(
              ([id, settings]) => [id, clientOf(settings)] as const,
            ),
            ...moduleModels,
          ]),
          rateLimits: {
            limiter: new KnexModelCallLimiter(db),
            requestsPerMinute,
          },
          audit: new AuditorAuditLog(auditor),
          clock,
          ids,
          logger,
          metrics: new BackstageMetrics(metrics),
          queueMaxMessages: aiChat.input.queueMaxMessages,
          insertMaxPerRun: aiChat.input.insertMaxPerRun,
          images: { ...aiChat.input.images, enabled: aiChat.llm.images },
          settings: {
            limits: {
              maxSteps: aiChat.maxTurns,
              maxToolCallsPerRun: aiChat.maxToolCallsPerRun,
              runTimeoutSeconds: aiChat.runTimeoutSeconds,
              maxToolCallsPerStep: aiChat.maxToolCallsPerStep,
              readConcurrency: aiChat.readConcurrency,
              toolTimeoutSeconds: aiChat.toolTimeoutSeconds,
            },
            budget: {
              ...aiChat.context,
              tokensPerImage: aiChat.input.images.tokensPerImage,
              maxImageBytesPerInput: aiChat.input.images.maxBytesPerInput,
            },
          },
          retentionDays: aiChat.retentionDays,
          liveShares: aiChat.sharing.live,
          extensions: {
            ...harnessExtensions.extensions({
              logger,
              maxToolOutputChars: aiChat.maxToolOutputChars,
              builtInContextProviders: [
                userContextProvider(),
                entityContextProvider(entities),
                planContextProvider(items),
              ],
              toolOutput: aiChat.toolOutput,
            }),
            skills,
          },
          notifier,
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

        await scheduler.scheduleTask({
          id: 'ai-chat-purge-unused-attachments',
          frequency: PURGE_ATTACHMENTS_EVERY,
          timeout: { minutes: 5 },
          fn: async () => {
            const deleted =
              await host.useCases.purgeUnusedAttachments.execute();
            if (deleted > 0) {
              logger.info(`AI chat deleted ${deleted} unused images`);
            }
          },
        });

        await scheduler.scheduleTask({
          id: 'ai-chat-purge-expired-sessions',
          frequency: PURGE_EXPIRED_SESSIONS_EVERY,
          timeout: { minutes: 5 },
          fn: async () => {
            const deleted = await host.useCases.purgeExpiredSessions.execute();
            if (deleted > 0) {
              logger.info(
                `AI chat deleted ${deleted} session(s) past the retention of ${aiChat.retentionDays} day(s)`,
              );
            }
          },
        });

        httpRouter.use(
          createRouter({
            principal: req =>
              principalFromRequest(req, { httpAuth, userInfo, auth }),
            useCases: host.useCases,
            inputConfig: inputConfigOf({
              images: {
                enabled: aiChat.llm.images,
                maxPerMessage: aiChat.input.images.maxPerMessage,
                maxBytes: aiChat.input.images.maxBytes,
                maxBytesPerInput: aiChat.input.images.maxBytesPerInput,
                maxPendingPerSession: aiChat.input.images.maxPendingPerSession,
              },
              insertMaxPerRun: aiChat.input.insertMaxPerRun,
              queueMaxMessages: aiChat.input.queueMaxMessages,
            }),
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
