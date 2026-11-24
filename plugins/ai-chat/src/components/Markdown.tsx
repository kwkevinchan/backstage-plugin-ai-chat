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

import { Fragment, ReactNode } from 'react';
import { cx } from './styles';

/**
 * Markdown for assistant messages, with a small set of elements: headings,
 * paragraphs, lists, block quotes, code, bold, italic and links. Every piece
 * of text becomes a React text node, so HTML in the text is shown as text
 * and never runs. A link is an anchor only for `http:`, `https:` and
 * `mailto:`; any other target (such as `javascript:`) shows its label only.
 */
export function Markdown({ text }: { text: string }) {
  return <div className={cx('chat-markdown')}>{renderBlocks(text)}</div>;
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const FENCE = /^```\s*([\w-]*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

function isBlockStart(line: string) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    QUOTE.test(line)
  );
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = blocks.length;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing fence (or the end of the text)
      blocks.push(
        <pre key={key} className={cx('chat-code')}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const Tag = `h${heading[1].length}` as 'h1' | 'h2' | 'h3';
      blocks.push(<Tag key={key}>{renderInline(heading[2])}</Tag>);
      i += 1;
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(pattern.exec(lines[i])![1]);
        i += 1;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={key}>
          {items.map((item, n) => (
            <li key={n}>{renderInline(item)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])![1]);
        i += 1;
      }
      blocks.push(
        <blockquote key={key}>{renderInline(quoted.join('\n'))}</blockquote>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={key}>{renderInline(paragraph.join('\n'))}</p>);
  }
  return blocks;
}

// Code, bold, italic, [label](target) and a bare http(s) address.
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()[\]"'{}\\]+)/g;

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last)
      nodes.push(...withBreaks(text.slice(last, at), nodes.length));
    const key = nodes.length;
    const [token] = match;
    if (match[1]) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (match[2]) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (match[3]) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (match[4]) {
      const split = token.lastIndexOf('](');
      const label = token.slice(1, split);
      const target = token.slice(split + 2, -1);
      nodes.push(
        SAFE_URL.test(target) ? (
          <Anchor key={key} href={target}>
            {label}
          </Anchor>
        ) : (
          <Fragment key={key}>{label}</Fragment>
        ),
      );
    } else {
      // Punctuation after an address belongs to the sentence.
      const address = token.replace(/[.,;:!?]+$/, '');
      nodes.push(
        <Anchor key={key} href={address}>
          {address}
        </Anchor>,
      );
      if (address.length < token.length) {
        nodes.push(token.slice(address.length));
      }
    }
    last = at + token.length;
  }
  if (last < text.length)
    nodes.push(...withBreaks(text.slice(last), nodes.length));
  return nodes;
}

function withBreaks(text: string, keyBase: number): ReactNode[] {
  return text
    .split('\n')
    .flatMap((part, n) =>
      n === 0 ? [part] : [<br key={`${keyBase}-${n}`} />, part],
    );
}

function Anchor(props: { href: string; children: ReactNode }) {
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
