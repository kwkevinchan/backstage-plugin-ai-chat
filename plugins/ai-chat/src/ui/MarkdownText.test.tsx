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

import { render, screen } from '@testing-library/react';
import { LinkedText } from './LinkedText';
import { safeUrl } from './MarkdownText';
import { assistantText, renderThread } from './__testUtils__/renderThread';

// The text of an assistant message goes through the runtime and
// `MarkdownText`, as on the page. S-02: these tests lock that the Markdown
// loads nothing, shows HTML as text and links only http, https and mailto.
// They may not be removed or relaxed.
function renderMarkdown({ text }: { text: string }) {
  return renderThread([assistantText(text)]);
}

describe('MarkdownText', () => {
  it('renders headings, lists, emphasis and code', () => {
    const { container } = renderMarkdown({
      text: '# Title\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n```\nlet x = 1;\n```',
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Title',
    );
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual([
      'one',
      'two',
      'first',
      'second',
    ]);
    expect(container.querySelector('pre code')).toHaveTextContent('let x = 1;');
  });

  it('shows HTML as text and never creates its elements', () => {
    const html =
      '<script>alert(1)</script> <img src=x onerror=alert(1)> <b>x</b>';
    const { container } = renderMarkdown({ text: html });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('<script>alert(1)</script>');
  });

  it('loads no image or other resource: the syntax of an image gives no element that fetches', () => {
    const text =
      '![logo](https://example.test/logo.png) ![x](data:image/png;base64,AAAA) <iframe src="https://example.test"></iframe>';
    const { container } = renderMarkdown({ text: text });
    expect(
      container.querySelectorAll('img, iframe, object, embed, video, audio'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('[src]')).toHaveLength(0);
  });

  it('makes links of http, https and mailto only', () => {
    const text =
      '[ok](https://example.test/a) [mail](mailto:a@example.test) [bad](javascript:alert(1)) [data](data:text/html,x) [rel](/catalog) [pr](//evil.test) and https://example.test/b.';
    renderMarkdown({ text: text });
    const links = screen.getAllByRole('link');
    expect(links.map(l => l.getAttribute('href'))).toEqual([
      'https://example.test/a',
      'mailto:a@example.test',
      'https://example.test/b',
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAttribute('target', '_blank');
    }
    // A refused target leaves its label.
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(document.body).toHaveTextContent('bad');
    expect(screen.queryByRole('link', { name: 'rel' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'pr' })).toBeNull();
    expect(document.body).toHaveTextContent('rel');
    expect(document.body).toHaveTextContent('pr');
  });

  // GFM finds bare addresses by its own rules, and this component keeps them:
  // in JSON written as text an address can take the next characters into the
  // link. Code has no links. A link that must open is written as a Markdown
  // link.
  it('follows GFM for bare addresses in JSON text and makes no link in code', () => {
    const { container } = renderMarkdown({
      text: '[{"u":"https://x.test/a"}] and {"u":"https://x.test/b"}\n\n```json\n{"u": "https://x.test/c"}\n```\n\n`https://x.test/d`',
    });
    expect(
      [...container.querySelectorAll('a')].map(a => a.getAttribute('href')),
    ).toEqual(['https://x.test/a', 'https://x.test/b%22%7D']);
    expect(container.querySelector('pre code')).toHaveTextContent(
      'https://x.test/c',
    );
    expect(container).toHaveTextContent('https://x.test/d');
  });

  it('shows footnotes as a plain list, with no ids and no hidden heading', () => {
    const { container } = renderThread([
      assistantText('first[^1]\n\n[^1]: note one', 'run_1'),
      assistantText('second[^1]\n\n[^1]: note two', 'run_2'),
    ]);
    expect(container.querySelectorAll('[id]')).toHaveLength(0);
    expect(container).not.toHaveTextContent('Footnotes');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container).toHaveTextContent('note one');
    expect(container).toHaveTextContent('note two');
  });

  it('keeps a half-written code block while the answer streams', () => {
    const { container } = renderMarkdown({ text: '```ts\nconst a =' });
    expect(container.querySelector('pre code')).toHaveTextContent('const a =');
  });
});

describe('MarkdownText with GFM', () => {
  it('renders a table', () => {
    const { container } = renderMarkdown({
      text: '| Service | Restarts |\n| --- | ---: |\n| payments | 1 |\n| search | 0 |',
    });
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(
      [...table!.querySelectorAll('th')].map(th => th.textContent),
    ).toEqual(['Service', 'Restarts']);
    expect(
      [...table!.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(td => td.textContent),
      ),
    ).toEqual([
      ['payments', '1'],
      ['search', '0'],
    ]);
  });

  it('keeps a table free of images and unsafe links', () => {
    const { container } = renderMarkdown({
      text: '| a | b |\n| --- | --- |\n| ![x](https://example.test/x.png) | [y](javascript:alert(1)) |',
    });
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('img, [src]')).toHaveLength(0);
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('safeUrl', () => {
  it.each([
    ['https://example.test/a', 'https://example.test/a'],
    ['http://example.test/a', 'http://example.test/a'],
    ['mailto:a@example.test', 'mailto:a@example.test'],
    // eslint-disable-next-line no-script-url -- the target the test refuses
    ['javascript:alert(1)', ''],
    // eslint-disable-next-line no-script-url -- the target the test refuses
    ['JavaScript:alert(1)', ''],
    ['data:text/html,x', ''],
    ['vbscript:x', ''],
    ['/catalog', ''],
    ['//example.test/a', ''],
  ])('%s becomes %j', (url, expected) => {
    expect(safeUrl(url)).toBe(expected);
  });
});

describe('LinkedText', () => {
  it('links the addresses in JSON text and nothing else', () => {
    render(
      <pre>
        <LinkedText
          text={
            '{\n  "workflowUrl": "https://example.test/w/1",\n  "x": "javascript:alert(1)"\n}'
          }
        />
      </pre>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.test/w/1');
    expect(link).toHaveTextContent('https://example.test/w/1');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
