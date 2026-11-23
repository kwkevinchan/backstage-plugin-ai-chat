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

// Copy of plugins/ai-chat-backend/src/common/index.ts, written by scripts/sync-common.mjs.
// Edit the backend file and run `yarn sync:common`.

/**
 * Definitions shared by the frontend and the backend: the types of the API
 * and of the response stream, and the paths of the routes.
 *
 * @packageDocumentation
 */

export * from './types';
export * from './paths';
