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

import type { ComponentProps } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { Anchor } from './LinkedText';
import { cx } from './styles';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/**
 * Only `http:`, `https:` and `mailto:` targets are kept (S-02). Any other
 * target, such as `javascript:`, `data:` or a relative path, becomes empty,
 * and the link shows its label only.
 */
export function safeUrl(url: string): string {
  return SAFE_URL.test(url) ? url : '';
}

type Props<T extends 'a' | 'h2' | 'li' | 'section'> = ComponentProps<T> & {
  'data-footnote-backref'?: unknown;
  'data-footnotes'?: unknown;
};

function Link(props: Props<'a'>) {
  // The way back from a footnote to its reference: a link inside the page,
  // which this component does not make.
  if (props['data-footnote-backref'] !== undefined) return null;
  const { href, children } = props;
  return href ? <Anchor href={href}>{children}</Anchor> : <>{children}</>;
}

// GFM footnotes get ids (`user-content-fn-1`, `footnote-label`) that repeat in
// every answer with a footnote, and a heading for screen readers only. The
// notes show as a plain list at the end of the answer: no ids, no heading,
// no links inside the page.
function Section({ children, ...props }: Props<'section'>) {
  if (props['data-footnotes'] === undefined)
    return <section>{children}</section>;
  return <div className={cx('chat-footnotes')}>{children}</div>;
}

function Heading2({ children, className }: Props<'h2'>) {
  if (className === 'sr-only') return null;
  return <h2>{children}</h2>;
}

function ListItem({ children }: Props<'li'>) {
  return <li>{children}</li>;
}

const plugins = [remarkGfm];
const disallowed = ['img'];
const components = { a: Link, section: Section, h2: Heading2, li: ListItem };

/**
 * The text of an assistant message as Markdown with GFM (tables, lists,
 * strike-through, bare addresses as links). It loads nothing (S-02): images
 * are not rendered, HTML in the text is shown as text (there is no
 * `rehype-raw`), and a link keeps only an `http:`, `https:` or `mailto:`
 * target. Code is shown without highlighting.
 */
export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className={cx('chat-markdown')}
      smooth={false}
      remarkPlugins={plugins}
      disallowedElements={disallowed}
      urlTransform={safeUrl}
      components={components}
    />
  );
}
