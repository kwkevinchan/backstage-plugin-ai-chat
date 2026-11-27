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


import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  MAX_REFERENCE_TEXT_LENGTH,
  MAX_REFERENCES_PER_MESSAGE,
  type ChatInputConfig,
  type ChatPageContext,
  type ChatReferenceInput,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatReference } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import {
  cutText,
  pageKey,
  referenceOf,
  sameReference,
  type DraftReference,
} from '../domain/references';

/** The limits of the references of one message (`GET /input-config`). */
export type ReferenceLimits = ChatInputConfig['references'];

const DEFAULT_LIMITS: ReferenceLimits = {
  maxPerMessage: MAX_REFERENCES_PER_MESSAGE,
  maxTextLength: MAX_REFERENCE_TEXT_LENGTH,
};

/** What the box carries besides its text and images (B-04). */
export interface SendContentsState {
  references: DraftReference[];
  /** The key of the page the user removed from the box, while they are on it. */
  closedPage?: string;
  /** References were left out because the box was full. */
  full?: boolean;
}

/**
 * The references and the page switch of one box. It outlives the components
 * of the box: the panel keeps one for its conversation, so that a reference
 * that another page gave stays until it is sent or removed.
 */
export interface SendContentsStore {
  getSnapshot(): SendContentsState;
  subscribe(listener: () => void): () => void;
  /**
   * Adds the references that the backend would take and that are not in the
   * box yet, up to the limit.
   */
  add(references: readonly AiChatReference[]): void;
  /** Removes references from the box, by `DraftReference.id`. */
  remove(ids: readonly string[]): void;
  /** Leaves the page with this key out of the messages. */
  closePage(key: string): void;
  /** Sends the page again. */
  openPage(): void;
  /** The limits of `GET /input-config`; references over them are cut. */
  setLimits(limits: ReferenceLimits): void;
}

export function createSendContentsStore(): SendContentsStore {
  let state: SendContentsState = { references: [] };
  let limits = DEFAULT_LIMITS;
  let nextId = 1;
  const listeners = new Set<() => void>();

  const commit = (next: SendContentsState) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  /** The state without the note that the box was full. */
  const withoutFull = (): SendContentsState => {
    const { full: _full, ...rest } = state;
    return rest;
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add(inputs) {
      const references = [...state.references];
      let full = false;
      for (const input of inputs) {
        const taken = referenceOf(input, limits.maxTextLength);
        if (!taken) {
          // eslint-disable-next-line no-console
          console.warn(
            'ai-chat: a reference needs an entity ref with a kind, or a text; it is not added.',
          );
          continue;
        }
        if (references.some(r => sameReference(r.reference, taken.reference))) {
          continue;
        }
        if (references.length >= limits.maxPerMessage) {
          full = true;
          continue;
        }
        references.push({
          id: `reference-${nextId++}`,
          reference: taken.reference,
          ...(taken.truncated && { truncated: true }),
        });
      }
      commit({ ...withoutFull(), references, ...(full && { full }) });
    },
    remove(ids) {
      const references = state.references.filter(r => !ids.includes(r.id));
      if (references.length === state.references.length && !state.full) {
        return;
      }
      commit({ ...withoutFull(), references });
    },
    closePage(key) {
      if (state.closedPage === key) return;
      commit({ ...state, closedPage: key });
    },
    openPage() {
      if (state.closedPage === undefined) return;
      const { closedPage: _closed, ...rest } = state;
      commit(rest);
    },
    setLimits(next) {
      if (
        next.maxPerMessage === limits.maxPerMessage &&
        next.maxTextLength === limits.maxTextLength
      ) {
        return;
      }
      limits = next;
      const references = state.references
        .slice(0, next.maxPerMessage)
        .map(draft => {
          const { reference } = draft;
          if (
            reference.kind !== 'text' ||
            reference.text.length <= next.maxTextLength
          ) {
            return draft;
          }
          return {
            ...draft,
            reference: {
              ...reference,
              text: cutText(reference.text, next.maxTextLength),
            },
            truncated: true,
          };
        });
      commit({ ...state, references });
    },
  };
}

/** The box of one conversation, as its components use it. */
export interface SendContents {
  /** The page the user is on. */
  page: ChatPageContext;
  /** Whether the messages carry the page. */
  pageIncluded: boolean;
  /** The page the messages carry: `undefined` while the user left it out. */
  sentPage: ChatPageContext | undefined;
  includePage(): void;
  excludePage(): void;
  references: DraftReference[];
  /** Most references in one message. */
  maxReferences: number;
  /** References were left out because the box was full. */
  overflowed: boolean;
  add(references: readonly AiChatReference[]): void;
  remove(id: string): void;
  /**
   * The references of the next message, and a function that removes those
   * from the box once the message was taken.
   */
  take(): { references: ChatReferenceInput[]; sent(): void };
}

export interface UseSendContentsOptions {
  store: SendContentsStore;
  /** The page the user is on. */
  page: ChatPageContext;
  /**
   * What counts as another page. By default the path and the entity of
   * `page`; the chat page counts as one page, whatever conversation is open.
   */
  pageKey?: string;
  /** `GET /input-config`; the default limits until it answers. */
  inputConfig?: ChatInputConfig;
}

/**
 * The box of one conversation on its store. A page the user removed stays
 * out until the user is on another page: then the page is sent again.
 */
export function useSendContents(options: UseSendContentsOptions): SendContents {
  const { store, page, inputConfig } = options;
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const key = options.pageKey ?? pageKey(page);
  const limits = inputConfig?.references ?? DEFAULT_LIMITS;

  useEffect(() => {
    store.setLimits(limits);
  }, [store, limits]);

  // On another page, the page that was removed is forgotten: coming back to
  // it sends it again.
  useEffect(() => {
    if (state.closedPage !== undefined && state.closedPage !== key) {
      store.openPage();
    }
  }, [store, state.closedPage, key]);

  const pageIncluded = state.closedPage !== key;
  const includePage = useCallback(() => store.openPage(), [store]);
  const excludePage = useCallback(() => store.closePage(key), [store, key]);
  const add = useCallback(
    (references: readonly AiChatReference[]) => store.add(references),
    [store],
  );
  const remove = useCallback((id: string) => store.remove([id]), [store]);
  const take = useCallback(() => {
    const drafts = store.getSnapshot().references;
    return {
      references: drafts.map(draft => draft.reference),
      sent: () => store.remove(drafts.map(draft => draft.id)),
    };
  }, [store]);

  return useMemo(
    () => ({
      page,
      pageIncluded,
      sentPage: pageIncluded ? page : undefined,
      includePage,
      excludePage,
      references: state.references,
      maxReferences: limits.maxPerMessage,
      overflowed: Boolean(state.full),
      add,
      remove,
      take,
    }),
    [
      page,
      pageIncluded,
      includePage,
      excludePage,
      state.references,
      state.full,
      limits.maxPerMessage,
      add,
      remove,
      take,
    ],
  );
}
