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

import { useState, type FormEvent } from 'react';
import { Button } from '@backstage/ui';
import type {
  ChatShare,
  ChatShareMode,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';
import { describeError } from '../adapters/describeError';
import { cx } from './styles';

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export interface ShareDialogProps {
  api: AiChatApi;
  sessionId: string;
  shares: ChatShare[];
  onSharesChange(shares: ChatShare[]): void;
  onClose(): void;
}

/**
 * Panel for creating, refreshing, and revoking read-only shares of a session
 * (SH-07, SH-10).
 */
export function ShareDialog(props: ShareDialogProps) {
  const { api, sessionId, shares, onSharesChange, onClose } = props;
  const [subjectRef, setSubjectRef] = useState('');
  const [mode, setMode] = useState<ChatShareMode>('snapshot');
  const [includeToolOutputs, setIncludeToolOutputs] = useState(true);
  const [includeLaterToolOutputs, setIncludeLaterToolOutputs] = useState(false);
  const [hours, setHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const trimmedSubject = subjectRef.trim();
  const isGroupTarget = trimmedSubject.toLowerCase().startsWith('group:');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmedSubject) return;
    setBusy(true);
    setError(undefined);
    try {
      const parsedHours = hours.trim() ? Number(hours.trim()) : undefined;
      const created = await api.createShare(sessionId, {
        subjectRef: trimmedSubject,
        mode,
        includeToolOutputs,
        ...(mode === 'live' && {
          includeLaterToolOutputs,
          ...(parsedHours !== undefined &&
            !Number.isNaN(parsedHours) && { hours: parsedHours }),
        }),
      });
      onSharesChange([...shares, created]);
      setSubjectRef('');
      setHours('');
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (shareId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api.updateShare(sessionId, shareId, {
        refresh: true,
      });
      onSharesChange(shares.map(s => (s.id === shareId ? updated : s)));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (shareId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.revokeShare(sessionId, shareId);
      onSharesChange(shares.filter(s => s.id !== shareId));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cx('share-dialog')}
      role="region"
      aria-label="Share conversation"
    >
      <div className={cx('share-dialog-header')}>
        <h3>Share conversation</h3>
        <Button
          variant="tertiary"
          size="small"
          onPress={onClose}
          aria-label="Close share dialog"
        >
          Close
        </Button>
      </div>

      <div className={cx('share-disclosure')}>
        <p>Recipients will see tool outputs retrieved with your permissions.</p>
        <p>
          Recipients can copy this conversation into their own session. Copied
          messages, plans, and images cannot be taken back.
        </p>
        {isGroupTarget && (
          <p role="note">
            When sharing with a group, anyone who joins the group later will
            also be able to see this conversation.
          </p>
        )}
      </div>

      {error && (
        <div className={cx('chat-error')} role="alert">
          {error}
        </div>
      )}

      <form onSubmit={submit} className={cx('share-form')}>
        <label className={cx('share-form-field')}>
          Recipient
          <input
            type="text"
            value={subjectRef}
            onChange={e => setSubjectRef(e.target.value)}
            placeholder="user:default/alice or group:default/team"
            disabled={busy}
          />
        </label>

        <label className={cx('share-form-field')}>
          Mode
          <select
            value={mode}
            onChange={e => setMode(e.target.value as ChatShareMode)}
            disabled={busy}
          >
            <option value="snapshot">Snapshot</option>
            <option value="live">Live updating</option>
          </select>
        </label>

        <label className={cx('share-form-checkbox')}>
          <input
            type="checkbox"
            checked={includeToolOutputs}
            onChange={e => {
              setIncludeToolOutputs(e.target.checked);
              if (!e.target.checked) setIncludeLaterToolOutputs(false);
            }}
            disabled={busy}
          />
          Include tool outputs
        </label>

        {mode === 'live' && (
          <>
            <label className={cx('share-form-checkbox')}>
              <input
                type="checkbox"
                checked={includeLaterToolOutputs}
                onChange={e => setIncludeLaterToolOutputs(e.target.checked)}
                disabled={busy || !includeToolOutputs}
              />
              Include later tool outputs
            </label>
            <label className={cx('share-form-field')}>
              Expires in (hours)
              <input
                type="number"
                min={1}
                step={1}
                value={hours}
                onChange={e => setHours(e.target.value)}
                placeholder="Default"
                disabled={busy}
              />
            </label>
          </>
        )}

        <div>
          <Button
            type="submit"
            variant="primary"
            size="small"
            isDisabled={busy || !subjectRef.trim()}
          >
            Create share
          </Button>
        </div>
      </form>

      {shares.length > 0 && (
        <ul className={cx('share-list')} aria-label="Active shares">
          {shares.map(share => (
            <li key={share.id} className={cx('share-list-item')}>
              <span>
                {share.subjectRef} ({share.mode}
                {share.expired ? ', expired' : ''}
                {share.expiresAt && !share.expired
                  ? `, expires ${formatTimestamp(share.expiresAt)}`
                  : ''}
                )
              </span>
              <span className={cx('share-list-actions')}>
                {share.mode === 'snapshot' && (
                  <Button
                    variant="secondary"
                    size="small"
                    isDisabled={busy}
                    onPress={() => refresh(share.id)}
                  >
                    Refresh
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="small"
                  isDisabled={busy}
                  onPress={() => revoke(share.id)}
                >
                  Stop sharing
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
