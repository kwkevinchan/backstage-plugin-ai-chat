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

import type { ReactNode } from 'react';

/** A link that opens in a new tab and tells the target nothing of this page. */
export function Anchor(props: { href: string; children: ReactNode }) {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}

/**
 * Text in which every `http:` and `https:` address is a link; the rest is
 * plain text. For JSON output of an action, so that a link such as
 * `workflowUrl` can be opened.
 */
export function LinkedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s"'<>\\]+)/);
  return (
    <>
      {parts.map((part, n) =>
        n % 2 === 1 ? (
          <Anchor key={n} href={part}>
            {part}
          </Anchor>
        ) : (
          part
        ),
      )}
    </>
  );
}
