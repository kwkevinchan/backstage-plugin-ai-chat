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

import type {
  CallContext,
  JsonObject,
  ToolCallItem,
  ToolDescriptor,
  ToolGateway,
  ToolOutput,
  ValidationResult,
} from '@kwkevinchan/ai-chat-harness';

/**
 * A tool of the fake gateway. Without `validate` every input is valid; without
 * `execute` the tool answers `ok` with an empty output.
 *
 * @public
 */
export type FakeTool = {
  descriptor: ToolDescriptor;
  validate?: (input: JsonObject) => ValidationResult;
  execute?: (
    call: ToolCallItem,
    opts: { signal: AbortSignal },
  ) => ToolOutput | Promise<ToolOutput>;
};

/**
 * A `ToolGateway` for tests. It records which calls were validated and which
 * ran.
 *
 * @public
 */
export class FakeToolGateway implements ToolGateway {
  /** The calls that ran, in order. */
  readonly executed: ToolCallItem[] = [];
  /** The tool ids and inputs that were validated, in order. */
  readonly validated: { toolId: string; input: JsonObject }[] = [];

  constructor(private readonly tools: FakeTool[]) {}

  async list(_ctx: CallContext): Promise<ToolDescriptor[]> {
    return this.tools.map(tool => tool.descriptor);
  }

  async validate(
    toolId: string,
    input: JsonObject,
    _ctx: CallContext,
  ): Promise<ValidationResult> {
    this.validated.push({ toolId, input });
    return this.find(toolId).validate?.(input) ?? { valid: true };
  }

  async execute(
    call: ToolCallItem,
    _ctx: CallContext,
    opts: { signal: AbortSignal },
  ): Promise<ToolOutput> {
    this.executed.push(call);
    const tool = this.find(call.toolId);
    return tool.execute
      ? tool.execute(call, opts)
      : { status: 'ok', output: {} };
  }

  private find(toolId: string): FakeTool {
    const tool = this.tools.find(t => t.descriptor.id === toolId);
    if (!tool) throw new Error(`FakeToolGateway has no tool ${toolId}`);
    return tool;
  }
}
