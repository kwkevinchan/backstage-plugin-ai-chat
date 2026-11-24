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
 * A conversation of one owner. The items of the session are in the log (see
 * `ItemLog`); the session keeps what is around them.
 */
export type Session = {
  id: string;
  /** The entity ref of the owner, for example `user:default/jane`. */
  ownerRef: string;
  agentId: string;
  title?: string;
  /** The entity the session is about, if any. */
  entityRef?: string;
  /** Ids of the toolsets the owner switched on for this session. */
  enabledToolsets: string[];
  forkedFrom?: { sessionId: string; seq: number };
  pinned: boolean;
  /** ISO 8601; set when the session is archived. */
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** What the caller gives to create a session. */
export type NewSession = {
  ownerRef: string;
  agentId: string;
  title?: string;
  entityRef?: string;
  enabledToolsets?: string[];
  forkedFrom?: { sessionId: string; seq: number };
};

/** The fields of a session the owner can change. */
export type SessionPatch = {
  /** `null` clears the title. */
  title?: string | null;
  pinned?: boolean;
  archived?: boolean;
  enabledToolsets?: string[];
};
