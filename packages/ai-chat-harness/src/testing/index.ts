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
 * Fakes and in-memory ports for testing code built on the harness.
 *
 * @packageDocumentation
 */

export { FakeClock, FakeRunControl, SequentialIdGenerator } from './fakes';
export { FakeToolGateway } from './FakeToolGateway';
export type { FakeTool } from './FakeToolGateway';
export { InMemoryItemLog } from './InMemoryItemLog';
export { itemLogContract } from './itemLogContract';
export type { ItemLogSubject } from './itemLogContract';
export { callTool, say, ScriptedModel } from './ScriptedModel';
export type { ScriptedStep } from './ScriptedModel';
