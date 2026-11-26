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

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Whether `href` is an absolute `http:`, `https:` or `mailto:` address.
 * Relative addresses and every other scheme, such as `javascript:` or
 * `data:`, are not.
 *
 * @public
 */
export function isSafeLinkHref(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/**
 * Props of {@link AiChatSafeLink}.
 *
 * @public
 */
export interface AiChatSafeLinkProps {
  /** The address, from untrusted data such as the output of an action. */
  href: unknown;
  /** The text of the link. Defaults to the address. */
  children?: ReactNode;
}

/**
 * A link for an address from the output of an action. Only an `http:`,
 * `https:` or `mailto:` address is a link; it opens in a new tab and tells the
 * target nothing of this page. Any other value is shown as plain text.
 *
 * @public
 */
export function AiChatSafeLink(props: AiChatSafeLinkProps): JSX.Element {
  const { href, children } = props;
  const text = children ?? (typeof href === 'string' ? href : String(href));
  if (!isSafeLinkHref(href)) return <span>{text}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
}
