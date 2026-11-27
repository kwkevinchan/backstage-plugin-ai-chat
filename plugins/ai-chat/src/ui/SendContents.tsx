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
  Component,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { useApiHolder } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { Button, Menu, MenuItem, MenuTrigger } from '@backstage/ui';
import {
  aiChatReferenceSourcesApiRef,
  type AiChatReferenceSourceProps,
} from '@kwkevinchan/backstage-plugin-ai-chat-react';
import type { SendContents } from '../application/sendContents';
import {
  pageLabel,
  referenceTag,
  type ShownReference,
} from '../domain/references';
import { CatalogEntityPicker } from './CatalogEntityPicker';
import { cx } from './styles';

/** The text of the tag of a text snippet that was cut to the limit. */
export const TRUNCATED_TEXT = 'Truncated';

/** The keys of the built-in items of "Add reference". */
const PAGE_ITEM = 'current-page';
const CATALOG_ITEM = 'catalog-entity';
const SOURCE_ITEM = 'source:';

interface MenuSource {
  key: string;
  title: string;
  component: ComponentType<AiChatReferenceSourceProps>;
}

/**
 * Shows nothing when the component of a reference source throws: the box
 * and the conversation stay.
 */
class SourceBoundary extends Component<
  { title: string; children: ReactNode },
  { failed: boolean }
> {
  static getDerivedStateFromError() {
    return { failed: true };
  }

  state = { failed: false };

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.warn(
      `ai-chat: the reference source ${this.props.title} failed.`,
      error,
      info.componentStack,
    );
  }

  render() {
    return this.state.failed ? (
      <div className={cx('chat-error')} role="alert">
        This source does not work now.
      </div>
    ) : (
      this.props.children
    );
  }
}

/** The tag of one reference: its name and kind, or its title and first words. */
function ReferenceTagContent(props: {
  reference: ShownReference;
  truncated?: boolean;
}) {
  const tag = referenceTag(props.reference);
  return (
    <>
      <span className={cx('chat-ref-label')}>{tag.label}</span>
      {tag.detail && (
        <span className={cx('chat-ref-detail')}>{tag.detail}</span>
      )}
      {tag.unreadable && (
        <span className={cx('chat-ref-badge')}>Not readable</span>
      )}
      {props.truncated && (
        <span className={cx('chat-ref-badge')}>{TRUNCATED_TEXT}</span>
      )}
    </>
  );
}

/**
 * The references a message carried, above its text. The sharee sees them
 * too: they are part of the message.
 */
export function MessageReferences(props: {
  references: readonly ShownReference[];
}) {
  if (props.references.length === 0) return null;
  return (
    <ul
      className={cx('chat-ref-tags', 'chat-message-refs')}
      aria-label="References of the message"
    >
      {props.references.map((reference, index) => (
        <li
          // A message keeps its references in order; they do not move.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className={cx('chat-ref-tag')}
          title={referenceTag(reference).description}
        >
          <ReferenceTagContent reference={reference} />
        </li>
      ))}
    </ul>
  );
}

/**
 * What the next message carries besides its text and images: the page the
 * user is on, which they can leave out and add back, and the references, which
 * they add from "Add reference" and can remove (B-04).
 */
export function SendContentsBar(props: { contents: SendContents }) {
  const { contents } = props;
  const apis = useApiHolder();
  const hasCatalog = Boolean(apis.get(catalogApiRef));
  const registered = apis.get(aiChatReferenceSourcesApiRef)?.getSources() ?? [];
  const [openKey, setOpenKey] = useState<string>();

  const sources: MenuSource[] = [
    ...(hasCatalog
      ? [
          {
            key: CATALOG_ITEM,
            title: 'Catalog entity',
            component: CatalogEntityPicker,
          },
        ]
      : []),
    ...registered.map(source => ({
      key: `${SOURCE_ITEM}${source.id}`,
      title: source.title,
      component: source.component,
    })),
  ];
  const full = contents.references.length >= contents.maxReferences;
  const open = sources.find(source => source.key === openKey);
  const label = pageLabel(contents.page);

  return (
    <div className={cx('chat-send-contents')}>
      <ul className={cx('chat-ref-tags')} aria-label="Sent with the message">
        <li>
          {contents.pageIncluded ? (
            <span
              className={cx('chat-ref-tag', 'chat-ref-page')}
              title={contents.page.entityRef ?? contents.page.path}
            >
              <span className={cx('chat-ref-detail')}>Page</span>
              <span className={cx('chat-ref-label')}>{label}</span>
              <button
                type="button"
                className={cx('chat-ref-remove')}
                aria-label="Leave out the current page"
                onClick={contents.excludePage}
              >
                ×
              </button>
            </span>
          ) : (
            <button
              type="button"
              className={cx('chat-ref-tag', 'chat-ref-off')}
              aria-label="Add the current page"
              onClick={contents.includePage}
            >
              ＋ Current page
            </button>
          )}
        </li>
        {contents.references.map(draft => {
          const tag = referenceTag(draft.reference);
          return (
            <li key={draft.id}>
              <span className={cx('chat-ref-tag')} title={tag.description}>
                <ReferenceTagContent
                  reference={draft.reference}
                  truncated={draft.truncated}
                />
                <button
                  type="button"
                  className={cx('chat-ref-remove')}
                  aria-label={`Remove ${tag.label}`}
                  onClick={() => contents.remove(draft.id)}
                >
                  ×
                </button>
              </span>
            </li>
          );
        })}
        <li>
          <MenuTrigger>
            <Button size="small" variant="tertiary">
              Add reference
            </Button>
            <Menu
              onAction={key => {
                if (key === PAGE_ITEM) contents.includePage();
                else setOpenKey(String(key));
              }}
            >
              <MenuItem id={PAGE_ITEM} isDisabled={contents.pageIncluded}>
                Current page
              </MenuItem>
              {sources.map(source => (
                <MenuItem key={source.key} id={source.key} isDisabled={full}>
                  {source.title}
                </MenuItem>
              ))}
            </Menu>
          </MenuTrigger>
        </li>
      </ul>
      {(full || contents.overflowed) && (
        <div className={cx('chat-ref-note')} role="status">
          A message carries at most {contents.maxReferences} references.
        </div>
      )}
      {open && (
        <section
          className={cx('chat-ref-source')}
          role="dialog"
          aria-label={open.title}
        >
          <div className={cx('chat-ref-source-bar')}>
            <span>{open.title}</span>
            <Button
              size="small"
              variant="tertiary"
              onPress={() => setOpenKey(undefined)}
            >
              Close
            </Button>
          </div>
          <SourceBoundary key={open.key} title={open.title}>
            <open.component
              onAdd={references => contents.add(references)}
              onClose={() => setOpenKey(undefined)}
            />
          </SourceBoundary>
        </section>
      )}
    </div>
  );
}
