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

export interface Config {
  /** Configuration of the unofficial AI chat plugin. */
  aiChat?: {
    /** The language model: any server with an OpenAI-compatible Chat Completions API. */
    llm: {
      /**
       * Base URL of the API, without the trailing `/chat/completions`, for
       * example `https://api.openai.com/v1`.
       */
      baseUrl: string;
      /**
       * Sent as `Authorization: Bearer <apiKey>`. Leave it out for a server
       * that needs no key.
       * @visibility secret
       */
      apiKey?: string;
      /** Model name sent with each request. */
      model: string;
      /** Seconds to wait for the model to finish one answer. Defaults to 120. */
      timeoutSeconds?: number;
    };
    /**
     * Most model calls for one user message, tool calls and decisions
     * included. Defaults to 10.
     */
    maxTurns?: number;
    /**
     * Instructions added to the built-in system prompt. They cannot remove
     * the built-in rules.
     */
    systemPrompt?: string;
    /** Which actions of the actions registry the chat can use. */
    actions?: {
      /**
       * Action ID patterns (`*` matches any characters), for example
       * `catalog:*`. When set, only the matching actions are offered.
       */
      include?: string[];
      /** Action ID patterns that are never offered. */
      exclude?: string[];
    };
    /**
     * Most characters of the output of an action that are stored and sent to
     * the model; the rest is cut. Defaults to 20000.
     */
    maxToolOutputChars?: number;
  };
}
