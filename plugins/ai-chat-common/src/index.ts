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
 * Types and definitions shared by the frontend and the backend of the AI chat:
 * the types of the HTTP API and of the response stream, the paths of the
 * routes, the permission to read a session, and the ids that both sides
 * derive in the same way.
 *
 * @packageDocumentation
 */

export * from './types';
export * from './paths';
export * from './page';
export * from './references';
export * from './permissions';
