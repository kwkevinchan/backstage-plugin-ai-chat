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
import { LinkedText, Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders headings, lists, emphasis and code', () => {
    const { container } = render(
      <Markdown
        text={
          '# Title\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n```\nlet x = 1;\n```'
        }
      />,
    );
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
    const { container } = render(<Markdown text={html} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('<script>alert(1)</script>');
  });

  it('loads no image or other resource: the syntax of an image gives no element that fetches', () => {
    const text =
      '![logo](https://example.test/logo.png) ![x](data:image/png;base64,AAAA) <iframe src="https://example.test"></iframe>';
    const { container } = render(<Markdown text={text} />);
    expect(
      container.querySelectorAll('img, iframe, object, embed, video, audio'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('[src]')).toHaveLength(0);
  });

  it('makes links of http, https and mailto only', () => {
    const text =
      '[ok](https://example.test/a) [mail](mailto:a@example.test) [bad](javascript:alert(1)) [data](data:text/html,x) and https://example.test/b.';
    render(<Markdown text={text} />);
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
  });

  it('ends an address before a quote, a brace or a comma', () => {
    const text = '{"url":"https://example.test/a"},{"x":1}';
    render(<Markdown text={text} />);
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://example.test/a',
    );
  });

  it('keeps a half-written code block while the answer streams', () => {
    const { container } = render(<Markdown text={'```ts\nconst a ='} />);
    expect(container.querySelector('pre code')).toHaveTextContent('const a =');
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
