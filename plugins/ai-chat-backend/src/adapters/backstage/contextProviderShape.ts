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

import { InputError } from '@backstage/errors';
import type { ContextProvider } from '@kwkevinchan/ai-chat-harness';
import { BUILT_IN_CONTEXT_PROVIDER_IDS } from '../../application/entityContext';
import { assertExtensionId } from './agentShape';

/**
 * Checks a context provider registered through
 * `aiChatHarnessExtensionPoint.addContextProvider` (X-03). The ids of the
 * built-in providers are taken.
 */
export function readExtensionContextProvider(value: unknown): ContextProvider {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError('context provider must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string') {
    throw new InputError('context provider: id must be a string');
  }
  assertExtensionId(record.id, `context provider ${record.id}`);
  if (BUILT_IN_CONTEXT_PROVIDER_IDS.includes(record.id)) {
    throw new InputError(
      `context provider ${record.id}: the id is taken by a built-in provider`,
    );
  }
  if (typeof record.provide !== 'function') {
    throw new InputError(
      `context provider ${record.id}: provide must be a function`,
    );
  }
  const provide = record.provide as ContextProvider['provide'];
  return { id: record.id, provide: ctx => provide.call(value, ctx) };
}
