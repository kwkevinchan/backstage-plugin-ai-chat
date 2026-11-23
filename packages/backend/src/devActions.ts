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
} from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';

type ServiceState = { status: 'running' | 'restarting'; restarts: number };

/**
 * Development only. A plugin with three actions on a few made-up services,
 * so that the chat can show the approval without another action source:
 *
 * - `dev-actions:list-services` only reads (`readOnly: true`): it runs at
 *   once.
 * - `dev-actions:restart-service` changes a service (`readOnly: false`): it
 *   waits for the approval of the user. It returns a link to the status page.
 * - `dev-actions:remove-service` is destructive: the approval card shows the
 *   badge.
 *
 * The state is in memory and is lost when the backend restarts.
 */
export const devActionsPlugin = createBackendPlugin({
  pluginId: 'dev-actions',
  register(env) {
    env.registerInit({
      deps: {
        actionsRegistry: actionsRegistryServiceRef,
        config: coreServices.rootConfig,
      },
      async init({ actionsRegistry, config }) {
        const appBaseUrl =
          config.getOptionalString('app.baseUrl') ?? 'http://localhost:3000';
        const services = new Map<string, ServiceState>(
          ['payments', 'search', 'billing'].map(name => [
            name,
            { status: 'running', restarts: 0 },
          ]),
        );
        const urlOf = (name: string) =>
          `${appBaseUrl}/catalog/default/component/example-${name}`;

        actionsRegistry.register({
          name: 'list-services',
          title: 'List services',
          description: 'Lists the example services and their status.',
          attributes: { readOnly: true, idempotent: true },
          schema: {
            input: z => z.object({}),
            output: z =>
              z.object({
                services: z.array(
                  z.object({
                    name: z.string(),
                    status: z.string(),
                    restarts: z.number(),
                    serviceUrl: z.string(),
                  }),
                ),
              }),
          },
          action: async () => ({
            output: {
              services: [...services].map(([name, state]) => ({
                name,
                status: state.status,
                restarts: state.restarts,
                serviceUrl: urlOf(name),
              })),
            },
          }),
        });

        actionsRegistry.register({
          name: 'restart-service',
          title: 'Restart a service',
          description:
            'Restarts one of the example services. The service is unavailable for a short time.',
          attributes: {
            readOnly: false,
            destructive: false,
            idempotent: false,
          },
          schema: {
            input: z =>
              z.object({
                name: z
                  .string()
                  .describe('Name of the service, for example payments'),
              }),
            output: z =>
              z.object({
                name: z.string(),
                status: z.string(),
                restarts: z.number(),
                statusUrl: z.string(),
              }),
          },
          action: async ({ input }) => {
            const state = services.get(input.name);
            if (!state) {
              throw new Error(`There is no service named ${input.name}`);
            }
            state.restarts += 1;
            return {
              output: {
                name: input.name,
                status: 'restarting',
                restarts: state.restarts,
                statusUrl: urlOf(input.name),
              },
            };
          },
        });

        actionsRegistry.register({
          name: 'remove-service',
          title: 'Remove a service',
          description: 'Removes one of the example services for good.',
          attributes: { readOnly: false, destructive: true, idempotent: true },
          schema: {
            input: z => z.object({ name: z.string() }),
            output: z => z.object({ removed: z.boolean() }),
          },
          action: async ({ input }) => ({
            output: { removed: services.delete(input.name) },
          }),
        });
      },
    });
  },
});
