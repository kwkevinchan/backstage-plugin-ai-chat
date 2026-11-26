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
  Cell,
  Column,
  Row,
  TableBody,
  TableHeader,
  TableRoot,
} from '@backstage/ui';
import {
  AiChatSafeLink,
  type AiChatToolResult,
  type AiChatToolResultProps,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';

type Service = {
  name: string;
  status: string;
  restarts: number;
  serviceUrl?: unknown;
};

// The output is untrusted data: check its shape, and draw nothing for any
// other shape (the row of the call still shows the raw output).
function servicesOf(output: unknown): Service[] | undefined {
  const services = (output as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) return undefined;
  const valid = services.every(
    service =>
      typeof service?.name === 'string' &&
      typeof service?.status === 'string' &&
      typeof service?.restarts === 'number',
  );
  return valid ? (services as Service[]) : undefined;
}

/** The output of `dev-actions:list-services` as a table. */
function ServicesTable(props: AiChatToolResultProps) {
  if (props.status !== 'complete') return null;
  const services = servicesOf(props.output);
  if (!services) return null;
  return (
    <TableRoot aria-label="Services">
      <TableHeader>
        <Column isRowHeader>Name</Column>
        <Column>Status</Column>
        <Column>Restarts</Column>
      </TableHeader>
      <TableBody>
        {services.map(service => (
          <Row key={service.name} id={service.name}>
            <Cell>
              <AiChatSafeLink href={service.serviceUrl}>
                {service.name}
              </AiChatSafeLink>
            </Cell>
            <Cell>{service.status}</Cell>
            <Cell>{String(service.restarts)}</Cell>
          </Row>
        ))}
      </TableBody>
    </TableRoot>
  );
}

/** The result component of the development action that lists services. */
export const listServicesResult: AiChatToolResult = {
  actionId: 'dev-actions:list-services',
  component: ServicesTable,
};
