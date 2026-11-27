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

import { Button, Card, CardBody, CardHeader, Flex, Text } from '@backstage/ui';
import type {
  AiChatReferenceSource,
  AiChatReferenceSourceProps,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';

const SNIPPETS = [
  {
    title: 'Restart policy',
    text: 'Restart the pods one at a time. Wait until the readiness check of a pod passes before the next one.',
  },
  {
    title: 'On-call hand-over',
    text: 'The hand-over is on Monday at 10:00. The outgoing engineer writes the open incidents and the pending changes into the on-call channel.',
  },
  {
    title: 'Release freeze',
    text: 'No release goes out from the 20th of December to the 3rd of January, except fixes for incidents.',
  },
];

/** A list of fixed snippets: a model for a source that lists pages or notes. */
function ExampleSnippets(props: AiChatReferenceSourceProps) {
  return (
    <Flex direction="column" gap="2">
      {SNIPPETS.map(snippet => (
        <Card key={snippet.title}>
          <CardHeader>{snippet.title}</CardHeader>
          <CardBody>
            <Flex direction="column" gap="2" align="start">
              <Text>{snippet.text}</Text>
              <Button
                size="small"
                onPress={() => {
                  props.onAdd([
                    {
                      kind: 'text',
                      text: snippet.text,
                      title: snippet.title,
                      url: '/catalog',
                    },
                  ]);
                  props.onClose();
                }}
              >
                Add
              </Button>
            </Flex>
          </CardBody>
        </Card>
      ))}
    </Flex>
  );
}

/** The reference source of the example: an item "Example snippets" in the menu. */
export const exampleSnippetsSource: AiChatReferenceSource = {
  id: 'example-snippets',
  title: 'Example snippets',
  component: ExampleSnippets,
};
