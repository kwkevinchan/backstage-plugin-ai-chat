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

import { Card, CardBody, CardHeader } from '@backstage/ui';
import { useEntity } from '@backstage/plugin-catalog-react';
import { AiChatLauncher } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { AskAiOnSelection } from './AskAiOnSelection';

type Entity = ReturnType<typeof useEntity>['entity'];

function entityRefOf(entity: Entity): string {
  const { namespace = 'default', name } = entity.metadata;
  return `${entity.kind.toLowerCase()}:${namespace}/${name}`;
}

/**
 * A card with a short runbook on the entity page. Select a sentence to get
 * "Ask AI"; the button below asks about this entity with a prompt that waits
 * in the input of the chat.
 */
export function RunbookCard() {
  const { entity } = useEntity();
  return (
    <Card>
      <CardHeader>Runbook</CardHeader>
      <CardBody>
        <AskAiOnSelection>
          <p>
            Restart the pods one at a time. Wait until the readiness check of a
            pod passes before you restart the next one.
          </p>
          <p>
            If the error rate stays above one percent for ten minutes after a
            restart, roll back to the last release and page the on-call
            engineer.
          </p>
        </AskAiOnSelection>
        <AiChatLauncher
          references={[{ kind: 'entity', entityRef: entityRefOf(entity) }]}
          prompt="Is this service ready for a restart?"
        >
          Ask AI about this service
        </AiChatLauncher>
      </CardBody>
    </Card>
  );
}
