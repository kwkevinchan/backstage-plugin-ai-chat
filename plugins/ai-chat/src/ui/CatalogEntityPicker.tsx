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

import { useEffect, useState } from 'react';
import { stringifyEntityRef, type Entity } from '@backstage/catalog-model';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import type { AiChatReferenceSourceProps } from '@kwkevinchan/backstage-plugin-ai-chat-react';
import { describeError } from '../adapters/describeError';
import { cx } from './styles';

/** How long the picker waits after the last key before it searches. */
export const CATALOG_SEARCH_DEBOUNCE_MS = 250;

/** Most entities one search shows. */
export const CATALOG_SEARCH_LIMIT = 20;

const FIELDS = [
  'kind',
  'metadata.name',
  'metadata.namespace',
  'metadata.title',
  'metadata.description',
];

type Found =
  | { state: 'loading' }
  | { state: 'done'; entities: Entity[] }
  | { state: 'error'; message: string };

/**
 * The entity picker of "Add reference", like `EntityPicker` of the
 * Scaffolder: the user types, the catalog searches the name and the title,
 * and a click adds the entity. The catalog answers with what the user may
 * read.
 */
export function CatalogEntityPicker(props: AiChatReferenceSourceProps) {
  const { onAdd, onClose } = props;
  const catalogApi = useApi(catalogApiRef);
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<Found>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setFound({ state: 'loading' });
    const trimmed = term.trim();
    const timer = setTimeout(
      () => {
        catalogApi
          .queryEntities({
            ...(trimmed && {
              fullTextFilter: {
                term: trimmed,
                fields: ['metadata.name', 'metadata.title'],
              },
            }),
            orderFields: { field: 'metadata.name', order: 'asc' },
            limit: CATALOG_SEARCH_LIMIT,
            fields: FIELDS,
          })
          .then(
            response => {
              if (!cancelled) {
                setFound({ state: 'done', entities: response.items });
              }
            },
            error => {
              if (!cancelled) {
                setFound({ state: 'error', message: describeError(error) });
              }
            },
          );
      },
      trimmed ? CATALOG_SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [catalogApi, term]);

  return (
    <div className={cx('chat-entity-picker')}>
      <input
        type="search"
        className={cx('chat-sidebar-search')}
        aria-label="Search the catalog"
        placeholder="Search by name or title"
        value={term}
        // The picker opens on a click of the user, for them to type.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onChange={event => setTerm(event.target.value)}
      />
      {found.state === 'loading' && (
        <div className={cx('chat-entity-picker-note')} role="status">
          Searching...
        </div>
      )}
      {found.state === 'error' && (
        <div className={cx('chat-error')} role="alert">
          {found.message}
        </div>
      )}
      {found.state === 'done' && found.entities.length === 0 && (
        <div className={cx('chat-entity-picker-note')} role="status">
          No entity found.
        </div>
      )}
      {found.state === 'done' && found.entities.length > 0 && (
        <ul className={cx('chat-entity-picker-list')} aria-label="Entities">
          {found.entities.map(entity => {
            const ref = stringifyEntityRef(entity);
            const name = entity.metadata.title ?? entity.metadata.name;
            return (
              <li key={ref}>
                <button
                  type="button"
                  className={cx('chat-entity-picker-item')}
                  title={ref}
                  onClick={() => {
                    onAdd([{ kind: 'entity', entityRef: ref }]);
                    onClose();
                  }}
                >
                  <span className={cx('chat-entity-picker-name')}>{name}</span>
                  <span className={cx('chat-entity-picker-meta')}>
                    {entity.kind}
                    {entity.metadata.namespace &&
                    entity.metadata.namespace !== 'default'
                      ? ` · ${entity.metadata.namespace}`
                      : ''}
                  </span>
                  {entity.metadata.description && (
                    <span className={cx('chat-entity-picker-description')}>
                      {entity.metadata.description}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
