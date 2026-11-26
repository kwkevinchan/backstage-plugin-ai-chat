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
 * What the chat reads of a catalog entity: the fields the built-in context
 * provider `entity` gives to the model, nothing else (X-03).
 */
export type EntityFacts = {
  kind: string;
  namespace: string;
  name: string;
  title?: string;
  description?: string;
  type?: string;
  lifecycle?: string;
  owner?: string;
  system?: string;
  tags?: string[];
};

const REF = /^(?:([^:/]+):)?(?:([^:/]+)\/)?([^:/]+)$/;

/**
 * The entity ref a session is bound to (SE-02), in the form
 * `stringifyEntityRef` of the catalog gives: `kind:namespace/name`, all in
 * lower case, `default` when the namespace is left out. `undefined` when the
 * value is not a ref or has no kind: the catalog cannot read an entity
 * without a kind. The characters of each part are checked where the value
 * comes in (`isEntityRef`).
 */
export function normalizeEntityRef(value: string): string | undefined {
  const match = REF.exec(value.trim());
  if (!match) return undefined;
  const [, kind, namespace, name] = match;
  if (kind === undefined) return undefined;
  return `${kind}:${namespace ?? 'default'}/${name}`.toLowerCase();
}
