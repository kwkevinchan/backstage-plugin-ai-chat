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
      /**
       * Whether the model reads images (JPEG, PNG, WebP, GIF). When it does,
       * the images a user attaches are sent to the model server as part of the
       * message, so they leave your organization if the server is outside it.
       * Defaults to false: the chat then takes no image.
       */
      images?: boolean;
    };
    /**
     * Most model calls in one run. A run is one message of the user and the
     * approvals that follow it. Defaults to 10.
     */
    maxTurns?: number;
    /**
     * Most tool calls the model may request in one run. A run is one message
     * of the user, with the approvals that follow it. Defaults to 30.
     */
    maxToolCallsPerRun?: number;
    /**
     * Seconds a run may work, not counting the time it waits for an approval.
     * The tools run with the token of the user, and a run also stops before
     * that token expires. At most 600, which is the shortest life of a token
     * that `auth.backstageTokenExpiration` allows. Defaults to 300.
     */
    runTimeoutSeconds?: number;
    /**
     * How much of a long session the model gets (H-09). Old tool outputs are
     * shortened first, then old steps are replaced by a summary.
     */
    context?: {
      /**
       * Size of the model input in tokens, estimated. Set it well below the
       * context window of the model. Defaults to 100000.
       */
      tokenBudget?: number;
      /** The newest steps that are never shortened or left out. Defaults to 6. */
      keepRecentSteps?: number;
    };
    /**
     * What the user may add while a run goes on. A message can be inserted
     * into the run, which the model reads in its next call, or queued, which
     * is sent as a new run when the run before it ends.
     */
    input?: {
      insert?: {
        /** Most messages inserted into one run, at most 20. Defaults to 5. */
        maxPerRun?: number;
      };
      queue?: {
        /** Most queued messages in one session. Defaults to 5. */
        maxMessages?: number;
      };
      /**
       * Images in messages. They need `llm.images`.
       */
      images?: {
        /** Most images in one message. Defaults to 4. */
        maxPerMessage?: number;
        /** Largest image, in bytes. Defaults to 5242880 (5 MB). */
        maxBytes?: number;
        /**
         * Most image bytes the model gets in one call, and the messages of one
         * run may have in all. At least `maxPerMessage` times `maxBytes`; a
         * smaller value stops the backend at startup. Defaults to 20971520
         * (20 MB).
         */
        maxBytesPerInput?: number;
        /**
         * Most images of a session that are uploaded and in no message yet.
         * Defaults to 12.
         */
        maxPendingPerSession?: number;
        /**
         * What one image counts in the context budget, in tokens. It is an
         * estimate, and it has not been measured against a real model. Too
         * low, and the input can pass the context limit of the model; too
         * high, and older images are left out sooner. Set it for the model
         * you use. Defaults to 1600.
         */
        tokensPerImage?: number;
      };
    };
    /**
     * Instructions added to the built-in system prompt. They cannot remove
     * the built-in rules.
     */
    systemPrompt?: string;
    /**
     * Which actions of the actions registry the chat can use.
     * @deprecated `toolsets` replaces these two lists. Without `toolsets` they
     * make the one `default` toolset; with `toolsets` they are ignored. The
     * backend logs a warning when they are set.
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
     * Limits for a share that keeps updating. Read at startup. Creating or
     * changing a share is not in this version, so these values are only
     * checked and kept. When `sharing` or `live` is left out, the defaults
     * are used.
     */
    sharing?: {
      live?: {
        /**
         * Whether a share may keep updating. Defaults to true. `false` is
         * stored as false.
         */
        enabled?: boolean;
        /**
         * Hours a live share lasts when nobody picks a life. A positive
         * integer, at most `maxHours`. Defaults to 24.
         */
        defaultHours?: number;
        /**
         * Longest life of a live share, in hours. A positive integer, at
         * least `defaultHours`. Defaults to 72.
         */
        maxHours?: number;
      };
    };
    /**
     * Agents. Without this, the only agent is `default`: the built-in system
     * prompt plus `systemPrompt`. An agent here is added next to that one.
     * An agent whose id is `default` replaces the built-in agent.
     *
     * The system prompt of a configured agent is the built-in rules plus this
     * agent's `systemPrompt`, or plus the installation `systemPrompt` when the
     * agent omits it. The two extra texts are not combined.
     *
     * `toolsets`, `skills`, `model`, `limits` and `planning` are recorded.
     * Configured and module-registered `skills` are loaded via `load_skill`
     * (omitting `skills` on an agent offers all registered skills; an empty
     * list offers none). The loop still uses the limits of the installation and
     * its one model client, and does not filter tools by the agent's toolsets,
     * require a plan, or call another model client yet. A value that is not
     * valid stops the backend at startup.
     *
     * A backend module can register further agents and skills through
     * `@kwkevinchan/backstage-plugin-ai-chat-node`. An id that both this block
     * (or `skills.directories`) and a module define stops the backend.
     */
    agents?: {
      [agentId: string]: {
        /** Name shown to the user. */
        title?: string;
        /**
         * Instructions added to the built-in rules, instead of the
         * installation `systemPrompt`.
         */
        systemPrompt?: string;
        /**
         * Toolset ids this agent names. Each one has to exist in `toolsets`
         * (or be `default`, when `toolsets` is not set).
         */
        toolsets?: string[];
        /**
         * Skill ids this agent may load with `load_skill`. Omit to allow all
         * registered skills; set `[]` to disable skills for this agent.
         */
        skills?: string[];
        /** Id of a model. The client for it is not selected yet. */
        model?: string;
        /**
         * `required`: a run of this agent is meant to plan first. That is not
         * enforced yet.
         */
        planning?: 'required';
        /**
         * Limits recorded for this agent. They do not replace `maxTurns`,
         * `maxToolCallsPerRun` or `runTimeoutSeconds`. 0 allows nothing.
         * `runTimeoutSeconds` is at most 600.
         */
        limits?: {
          /** Model calls. */
          maxSteps?: number;
          /** Tool calls the model may ask for. */
          maxToolCallsPerRun?: number;
          /** Seconds of working time, at most 600. */
          runTimeoutSeconds?: number;
        };
      };
    };
    /**
     * Most characters of the output of an action, and of the text
     * `load_skill` returns, that are stored and sent to the model; the rest is
     * cut. At least 100 (a smaller value stops the backend at startup).
     * Defaults to 20000.
     */
    maxToolOutputChars?: number;
    /**
     * How long a session is kept. A task runs every hour and deletes a
     * session whose last change is older than `days`, with its runs,
     * messages, queued messages and images. The audit log is not part of the
     * session and is left as it is. A session with a run that has not ended
     * is kept until that run ends. Pinning or archiving a session does not
     * keep it past `days`; those changes do count as a change, so the time
     * starts again from then. Defaults to 90. Set `days` to 0 to keep every
     * session.
     */
    retention?: {
      /**
       * Days after the last change of a session. One day is 24 hours. A
       * session changed exactly this long ago is kept. 0 keeps every session.
       * Defaults to 90.
       */
      days?: number;
    };
    /**
     * Directories of `SKILL.md` skills read at startup (X-04, D-22). Each
     * direct subdirectory with a `SKILL.md` registers one skill whose name and
     * description are placed in step context and whose body is read lazily on
     * `load_skill`.
     */
    skills?: {
      /** Paths to directories whose direct subdirectories contain `SKILL.md`. */
      directories?: string[];
    };
  };
}
