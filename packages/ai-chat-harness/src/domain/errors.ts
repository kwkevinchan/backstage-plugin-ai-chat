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
 * Base class of the errors of the harness. `code` tells the kinds apart
 * without `instanceof`, for example across package copies.
 *
 * @public
 */
export class HarnessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A run changed to a status it cannot change to. @public */
export class InvalidRunTransition extends HarnessError {
  constructor(from: string, to: string) {
    super(
      'INVALID_RUN_TRANSITION',
      `A run cannot change from ${from} to ${to}`,
    );
  }
}

/** An item with the same dedupe key is already in the log. @public */
export class DuplicateItem extends HarnessError {
  readonly dedupeKey: string;

  constructor(dedupeKey: string) {
    super('DUPLICATE_ITEM', `An item with the key ${dedupeKey} exists`);
    this.dedupeKey = dedupeKey;
  }
}

/** The lease of the run belongs to someone else now. @public */
export class LeaseLost extends HarnessError {
  readonly runId: string;

  constructor(runId: string) {
    super('LEASE_LOST', `The lease of run ${runId} is not held any more`);
    this.runId = runId;
  }
}
