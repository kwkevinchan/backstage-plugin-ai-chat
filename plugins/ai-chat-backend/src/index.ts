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

/**
 * Backend plugin of the AI chat for Backstage.
 *
 * @packageDocumentation
 */

export { aiChatPlugin as default } from './plugin';
export { aiChatSignalsModule } from './signals';
export {
  aiChatSessionConditions,
  createAiChatConditionalDecision,
} from './adapters/backstage/sessionAccess';
export type {
  SessionAccess,
  SessionAccessQuery,
} from './adapters/backstage/sessionAccess';
export {
  aiChatToolsetConditions,
  createAiChatToolsetConditionalDecision,
} from './adapters/backstage/toolsetAccess';
export type {
  ToolsetAccess,
  ToolsetAccessQuery,
} from './adapters/backstage/toolsetAccess';
