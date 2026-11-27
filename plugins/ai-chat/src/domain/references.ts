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


import {
  isEntityRef,
  isReferenceUrl,
  MAX_REFERENCE_TEXT_LENGTH,
  MAX_REFERENCE_TITLE_LENGTH,
  type ChatMessageReference,
  type ChatPageContext,
  type ChatReferenceInput,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatReference } from '@kwkevinchan/backstage-plugin-ai-chat-react';

/** A reference in the box: what is sent, and what the tag shows. */
export interface DraftReference {
  /** The key of the tag; unique in the box. */
  id: string;
  reference: ChatReferenceInput;
  /** The text was cut to the limit. */
  truncated?: boolean;
  /** The name to show for an entity, when the source knew its title. */
  label?: string;
}

/** A reference of a message as the screen shows it: sent, or stored by the backend. */
export type ShownReference = ChatReferenceInput | ChatMessageReference;

/** How many characters of a text snippet its tag shows. */
export const TEXT_PREVIEW_LENGTH = 32;

/**
 * An entity ref with a kind, in the form the backend stores
 * (`kind:namespace/name`, lower case). `undefined` for a ref without a kind
 * or that is not a ref: the catalog cannot read it.
 */
export function entityRefWithKind(value: string): string | undefined {
  const trimmed = value.trim();
  if (!isEntityRef(trimmed)) return undefined;
  const match = /^([^:/]+):(?:([^:/]+)\/)?([^:/]+)$/.exec(trimmed);
  if (!match) return undefined;
  const [, kind, namespace, name] = match;
  return `${kind}:${namespace ?? 'default'}/${name}`.toLowerCase();
}

/** The kind (when there is one), namespace and name of an entity ref. */
export function entityRefParts(entityRef: string): {
  kind?: string;
  namespace: string;
  name: string;
} {
  const match = /^(?:([^:/]+):)?(?:([^:/]+)\/)?([^:/]+)$/.exec(entityRef);
  if (!match) return { namespace: 'default', name: entityRef };
  return {
    ...(match[1] !== undefined && { kind: match[1] }),
    namespace: match[2] ?? 'default',
    name: match[3],
  };
}

/**
 * The first `max` UTF-16 units of a text, as the backend counts them. A
 * surrogate pair is not split.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// The backend refuses a NUL in a text.
const withoutNul = (value: string) => value.replace(/\0/g, '');

/**
 * A reference that a source or a launch gave, in the form the backend takes:
 * an entity ref with a kind, a text that is not empty, cut to `maxTextLength`,
 * a title cut to its limit, and a link only when it is one the backend takes.
 * `undefined` when there is nothing the backend would take.
 */
export function referenceOf(
  input: AiChatReference,
  maxTextLength: number = MAX_REFERENCE_TEXT_LENGTH,
): { reference: ChatReferenceInput; truncated: boolean } | undefined {
  if (input?.kind === 'entity') {
    if (typeof input.entityRef !== 'string') return undefined;
    const entityRef = entityRefWithKind(input.entityRef);
    return entityRef
      ? { reference: { kind: 'entity', entityRef }, truncated: false }
      : undefined;
  }
  if (input?.kind !== 'text' || typeof input.text !== 'string') {
    return undefined;
  }
  const full = withoutNul(input.text);
  if (full.trim().length === 0) return undefined;
  const text = cutText(full, maxTextLength);
  const title =
    typeof input.title === 'string'
      ? cutText(withoutNul(input.title).trim(), MAX_REFERENCE_TITLE_LENGTH)
      : '';
  const url =
    typeof input.url === 'string' && isReferenceUrl(input.url)
      ? input.url
      : undefined;
  return {
    reference: {
      kind: 'text',
      text,
      ...(title && { title }),
      ...(url && { url }),
    },
    truncated: text.length < full.length,
  };
}

/** Whether two references name the same entity, or are the same snippet. */
export function sameReference(
  a: ChatReferenceInput,
  b: ChatReferenceInput,
): boolean {
  if (a.kind === 'entity' || b.kind === 'entity') {
    return (
      a.kind === 'entity' && b.kind === 'entity' && a.entityRef === b.entityRef
    );
  }
  return a.text === b.text && a.title === b.title && a.url === b.url;
}

/** A reference of a stored message, as a request takes it again. */
export function referenceInputOf(reference: ShownReference): ChatReferenceInput {
  if (reference.kind === 'entity') {
    return { kind: 'entity', entityRef: reference.entityRef };
  }
  return {
    kind: 'text',
    text: reference.text,
    ...(reference.title !== undefined && { title: reference.title }),
    ...(reference.url !== undefined && { url: reference.url }),
  };
}

/** What the tag of a reference shows. */
export interface ReferenceTag {
  /** The name: the entity, or the title of the snippet. */
  label: string;
  /** The kind of the entity, or the first words of the snippet. */
  detail?: string;
  /** The whole text, for the tooltip. */
  description: string;
  /** The backend could not read the entity. */
  unreadable?: boolean;
}

export function referenceTag(
  reference: ShownReference,
  label?: string,
): ReferenceTag {
  if (reference.kind === 'entity') {
    const parts = entityRefParts(reference.entityRef);
    if ('readable' in reference && reference.readable) {
      const name = reference.entity.title ?? reference.entity.name;
      return {
        label: name,
        detail: reference.entity.kind,
        description: reference.entityRef,
      };
    }
    const unreadable = 'readable' in reference && !reference.readable;
    return {
      label: label ?? parts.name,
      detail: parts.kind,
      description: reference.entityRef,
      ...(unreadable && { unreadable }),
    };
  }
  const flat = reference.text.replace(/\s+/g, ' ').trim();
  const preview =
    flat.length > TEXT_PREVIEW_LENGTH
      ? `${cutText(flat, TEXT_PREVIEW_LENGTH)}…`
      : flat;
  return reference.title
    ? {
        label: reference.title,
        detail: preview,
        description: reference.url
          ? `${reference.title} (${reference.url})`
          : reference.title,
      }
    : { label: preview, description: preview };
}

/** What the tag of the page shows: the entity, or the path. */
export function pageLabel(page: ChatPageContext): string {
  return page.entityRef ? entityRefParts(page.entityRef).name : page.path;
}

/** Two pages with the same key are the same page for the tag of the page. */
export function pageKey(page: ChatPageContext): string {
  return `${page.path}\n${page.entityRef ?? ''}`;
}
