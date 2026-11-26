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
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { Button } from '@backstage/ui';
import {
  RiAddLine,
  RiArchiveLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiInboxUnarchiveLine,
  RiPencilLine,
  RiPushpinFill,
  RiPushpinLine,
} from '@remixicon/react';
import { readThreadCustom } from '../adapters/assistantUi/threadListAdapter';
import type { SessionSignalActivity } from '../adapters/signals';
import { describeError } from '../adapters/describeError';
import { cx } from './styles';

type SidebarContextValue = {
  openId: string;
  signalActivities: Record<string, SessionSignalActivity>;
  onClearError(): void;
  onArchiveStart(remoteId: string): void;
  onUnarchive(remoteId: string): void;
};

const SidebarContext = createContext<SidebarContextValue>({
  openId: '',
  signalActivities: {},
  onClearError: () => {},
  onArchiveStart: () => {},
  onUnarchive: () => {},
});

const DEFAULT_TITLE = 'New conversation';

type DisplayBadge = 'running' | 'waiting_approval' | 'replied';

function badgeFor(
  remoteId: string | undefined,
  openId: string,
  listActivity: 'running' | 'waiting_approval' | undefined,
  signalActivities: Record<string, SessionSignalActivity>,
): DisplayBadge | undefined {
  if (!remoteId) return listActivity;
  const pushed = signalActivities[remoteId];
  if (pushed === 'running' || pushed === 'waiting_approval') return pushed;
  if (pushed === 'replied') {
    return remoteId === openId ? undefined : 'replied';
  }
  if (pushed === 'idle') return undefined;
  return listActivity;
}

const BADGE_LABEL: Record<DisplayBadge, string> = {
  running: 'Processing',
  waiting_approval: 'Waiting for approval',
  replied: 'New reply',
};

const BADGE_CLASS: Record<DisplayBadge, string> = {
  running: 'chat-conversation-badge-running',
  waiting_approval: 'chat-conversation-badge-waiting',
  replied: 'chat-conversation-badge-replied',
};

function ThreadListItemRow() {
  const aui = useAui();
  const item = useAuiState(s => s.threadListItem);
  const {
    openId,
    signalActivities,
    onClearError,
    onArchiveStart,
    onUnarchive,
  } = useContext(SidebarContext);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const remoteId = item.remoteId ?? item.id;
  const isArchived = item.status === 'archived';
  const isSelected = Boolean(openId && remoteId === openId);
  const displayTitle = item.title || DEFAULT_TITLE;
  const custom = readThreadCustom(item.custom);
  const badge = badgeFor(remoteId, openId, custom.activity, signalActivities);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
    }
  }, [renaming]);

  const startRename = () => {
    onClearError();
    // Initial value is the actual stored title, or empty when untitled.
    setDraft(item.title ?? '');
    setRenaming(true);
  };

  const cancelRename = () => {
    setRenaming(false);
  };

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onClearError();
    aui.threadListItem.rename(trimmed);
    setRenaming(false);
  };

  const togglePin = () => {
    onClearError();
    aui.threadListItem.updateCustom({
      ...item.custom,
      pinned: !custom.pinned,
    });
  };

  return (
    <ThreadListItemPrimitive.Root
      className={cx(
        'chat-conversation',
        isSelected && 'chat-conversation-selected',
      )}
    >
      {renaming ? (
        <form
          className={cx('chat-conversation-rename')}
          onSubmit={submitRename}
        >
          <input
            ref={inputRef}
            type="text"
            className={cx('chat-conversation-rename-input')}
            aria-label="Conversation title"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              }
            }}
          />
          <button
            type="submit"
            className={cx('chat-icon-button')}
            aria-label="Save title"
            disabled={!draft.trim()}
          >
            <RiCheckLine size="1em" />
          </button>
          <button
            type="button"
            className={cx('chat-icon-button')}
            aria-label="Cancel rename"
            onClick={cancelRename}
          >
            <RiCloseLine size="1em" />
          </button>
        </form>
      ) : (
        <div className={cx('chat-conversation-row')}>
          <ThreadListItemPrimitive.Trigger
            className={cx('chat-conversation-open')}
            aria-current={isSelected || undefined}
            onClick={event => {
              onClearError();
              if (isArchived) {
                event.preventDefault();
                aui.threadListItem.switchTo({ unarchive: false });
              }
            }}
          >
            <span className={cx('chat-conversation-title')}>
              <ThreadListItemPrimitive.Title fallback={DEFAULT_TITLE} />
            </span>
          </ThreadListItemPrimitive.Trigger>
          <div className={cx('chat-conversation-actions')}>
            {!isArchived && (
              <button
                type="button"
                className={cx(
                  'chat-icon-button',
                  custom.pinned && 'chat-icon-button-active',
                )}
                aria-label={
                  custom.pinned
                    ? `Unpin conversation ${displayTitle}`
                    : `Pin conversation ${displayTitle}`
                }
                aria-pressed={custom.pinned}
                onClick={togglePin}
              >
                {custom.pinned ? (
                  <RiPushpinFill size="1em" />
                ) : (
                  <RiPushpinLine size="1em" />
                )}
              </button>
            )}
            <button
              type="button"
              className={cx('chat-icon-button')}
              aria-label={`Rename conversation ${displayTitle}`}
              onClick={startRename}
            >
              <RiPencilLine size="1em" />
            </button>
            {isArchived ? (
              <button
                type="button"
                className={cx('chat-icon-button')}
                aria-label={`Unarchive conversation ${displayTitle}`}
                onClick={() => onUnarchive(remoteId)}
              >
                <RiInboxUnarchiveLine size="1em" />
              </button>
            ) : (
              <ThreadListItemPrimitive.Archive
                className={cx('chat-icon-button')}
                aria-label={`Archive conversation ${displayTitle}`}
                onClick={() => {
                  onClearError();
                  onArchiveStart(remoteId);
                }}
              >
                <RiArchiveLine size="1em" />
              </ThreadListItemPrimitive.Archive>
            )}
            <ThreadListItemPrimitive.Delete
              className={cx('chat-icon-button')}
              aria-label={`Delete conversation ${displayTitle}`}
              onClick={onClearError}
            >
              <RiDeleteBinLine size="1em" />
            </ThreadListItemPrimitive.Delete>
          </div>
        </div>
      )}
      {badge && (
        <span className={cx('chat-conversation-badge', BADGE_CLASS[badge])}>
          {BADGE_LABEL[badge]}
        </span>
      )}
    </ThreadListItemPrimitive.Root>
  );
}

export interface ThreadListSidebarProps {
  openId: string;
  search: string;
  onSearchChange(value: string): void;
  showArchived: boolean;
  onShowArchivedChange(value: boolean): void;
  actionError?: string;
  onClearError(): void;
  onArchiveStart(remoteId: string): void;
  onUnarchive(remoteId: string): void;
  onNewChat(): void;
  signalActivities: Record<string, SessionSignalActivity>;
}

/** Conversation list built on assistant-ui's ThreadList primitives. */
export function ThreadListSidebar(props: ThreadListSidebarProps) {
  const {
    openId,
    search,
    onSearchChange,
    showArchived,
    onShowArchivedChange,
    actionError,
    onClearError,
    onArchiveStart,
    onUnarchive,
    onNewChat,
    signalActivities,
  } = props;
  const loadError = useAuiState(s => s.threads.loadError);
  const archivedCount = useAuiState(s => s.threads.archivedThreadIds.length);
  const archivedToggleId = useId();
  const errorText =
    actionError ?? (loadError ? describeError(loadError) : undefined);

  const contextValue = useMemo<SidebarContextValue>(
    () => ({
      openId,
      signalActivities,
      onClearError,
      onArchiveStart,
      onUnarchive,
    }),
    [openId, signalActivities, onClearError, onArchiveStart, onUnarchive],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <nav className={cx('chat-sidebar')} aria-label="Conversations">
        <Button
          variant="secondary"
          iconStart={<RiAddLine size="1em" />}
          onPress={() => {
            onClearError();
            onNewChat();
          }}
        >
          New chat
        </Button>
        <input
          type="search"
          className={cx('chat-sidebar-search')}
          aria-label="Search conversations"
          placeholder="Search conversations"
          value={search}
          onChange={e => {
            onClearError();
            onSearchChange(e.target.value);
          }}
        />
        <div className={cx('chat-sidebar-toggle')}>
          <input
            id={archivedToggleId}
            type="checkbox"
            checked={showArchived}
            onChange={e => {
              onClearError();
              onShowArchivedChange(e.target.checked);
            }}
          />
          <label htmlFor={archivedToggleId}>Show archived</label>
        </div>
        {errorText && (
          <div className={cx('chat-error')} role="alert">
            {errorText}
          </div>
        )}
        <ThreadListPrimitive.Root>
          <ThreadListPrimitive.Items
            components={{ ThreadListItem: ThreadListItemRow }}
          />
          {showArchived && archivedCount > 0 && (
            <>
              <div className={cx('chat-sidebar-section')}>Archived</div>
              <ThreadListPrimitive.Items
                archived
                components={{ ThreadListItem: ThreadListItemRow }}
              />
            </>
          )}
        </ThreadListPrimitive.Root>
      </nav>
    </SidebarContext.Provider>
  );
}
