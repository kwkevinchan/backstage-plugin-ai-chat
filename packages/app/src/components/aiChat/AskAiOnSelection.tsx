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

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@backstage/ui';
import { useAiChatPanel } from '@kwkevinchan/backstage-plugin-ai-chat-react';

type Selected = { text: string; left: number; top: number };

/** The selection, when it is not empty and lies inside `container`. */
function selectionIn(container: HTMLElement): Selected | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return undefined;
  const text = selection.toString().trim();
  if (text === '') return undefined;
  const box = range.getBoundingClientRect();
  return { text, left: box.left, top: box.bottom + 6 };
}

/**
 * Shows "Ask AI" under the text the user selects inside it. The button opens
 * the chat with the selected text as a reference: the title and the path of
 * this page say where the text is from. The user sees the text in the box of
 * the chat and decides whether to send it.
 *
 * A plugin puts a button like this on the pages it owns, where its text is
 * worth asking about; the chat itself adds nothing to other pages.
 */
export function AskAiOnSelection(props: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Selected>();
  const { open } = useAiChatPanel();

  useEffect(() => {
    const update = () => {
      setSelected(
        container.current ? selectionIn(container.current) : undefined,
      );
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  return (
    <div ref={container}>
      {props.children}
      {selected &&
        createPortal(
          // Pressing the button must not clear the selection before the click.
          <div
            role="presentation"
            style={{
              position: 'fixed',
              left: selected.left,
              top: selected.top,
              zIndex: 1300,
            }}
            onMouseDown={event => event.preventDefault()}
          >
            <Button
              size="small"
              onPress={() => {
                open({
                  references: [
                    {
                      kind: 'text',
                      text: selected.text,
                      title: document.title,
                      url: window.location.pathname,
                    },
                  ],
                });
                window.getSelection()?.removeAllRanges();
              }}
            >
              Ask AI
            </Button>
          </div>,
          document.body,
        )}
    </div>
  );
}
