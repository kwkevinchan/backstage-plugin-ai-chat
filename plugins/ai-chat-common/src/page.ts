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

const KIND = /^[A-Za-z][A-Za-z0-9]*$/;
// The rules of `KubernetesValidatorFunctions` of `@backstage/catalog-model`.
const NAMESPACE = /^[a-z0-9]+(?:-+[a-z0-9]+)*$/;
const NAME = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;

/**
 * Whether a text is an entity reference in the form of the catalog:
 * `[kind:][namespace/]name`, each part with the characters and the length (63)
 * that `@backstage/catalog-model` allows (`KubernetesValidatorFunctions`). The page of a message is given by the client and read
 * by the model, so both sides check it with this and with `isPagePath`.
 *
 * @public
 */
export function isEntityRef(value: string): boolean {
  if (value.length > 255) return false;
  const match = /^(?:([^:/]+):)?(?:([^:/]+)\/)?([^:/]+)$/.exec(value);
  if (!match) return false;
  const [, kind, namespace, name] = match;
  return (
    (kind === undefined || (kind.length <= 63 && KIND.test(kind))) &&
    (namespace === undefined ||
      (namespace.length <= 63 && NAMESPACE.test(namespace))) &&
    name.length <= 63 &&
    NAME.test(name)
  );
}

/**
 * Whether a text is the path of a page: it starts with `/`, has no blank and
 * no control character, and is at most 2000 characters long.
 *
 * @public
 */
export function isPagePath(value: string): boolean {
  return value.length <= 2000 && /^\/[^\s\p{C}]*$/u.test(value);
}
