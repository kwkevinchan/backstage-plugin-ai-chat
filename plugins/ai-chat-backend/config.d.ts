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
    /**
     * Which actions of the actions registry the chat can use.
     * @deprecated `toolsets` replaces these two lists once the new agent loop
     * is connected. Until then the chat still filters actions with them, with
     * or without `toolsets`, and the backend logs a warning when they are set.
     */
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
     * Groups of actions, by toolset id. A session offers the actions of the
     * toolsets that are switched on for it; the user switches toolsets on and
     * off in their own session, but only these. An action in no toolset is
     * never offered. When this is not set, one toolset with every action (or
     * the ones left by the deprecated `actions`) is on for every session.
     */
    toolsets?: {
      [toolsetId: string]: {
        /** Name shown to the user. */
        title?: string;
        /** Action ID patterns (`*` matches any characters), for example `catalog:*`. */
        actions: string[];
        /** Action ID patterns that are not part of the toolset. */
        exclude?: string[];
        /** Whether a new session has the toolset switched on. Defaults to false. */
        default?: boolean;
        /**
         * Set it when the actions send data out of the organization. Such an
         * action asks for approval even when it is read-only. Defaults to
         * false.
         */
        egress?: boolean;
      };
    };
    /**
     * What happens when the model calls an action, by action ID: `allow` runs
     * it at once, `ask` asks the user first, `deny` never runs it and never
     * offers it. `allow` takes effect only for an action that marks itself
     * read-only and is not in an `egress` toolset; any other action asks, and
     * the backend logs a warning. Keys are complete action IDs; a key with `*`
     * is refused. An action that is not listed is `allow` when
     * it is read-only and `ask` otherwise.
     */
    policy?: {
      [actionId: string]: 'allow' | 'ask' | 'deny';
    };
    /**
     * Most characters of the output of an action that are stored and sent to
     * the model; the rest is cut. Defaults to 20000.
     */
    maxToolOutputChars?: number;
  };
}
