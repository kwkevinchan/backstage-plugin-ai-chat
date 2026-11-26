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
import { AiChatSafeLink, isSafeLinkHref } from './AiChatSafeLink';

describe('isSafeLinkHref', () => {
  it.each([
    'http://example.com/a',
    'https://example.com/a?b=c',
    'mailto:team@example.com',
    'HTTPS://example.com',
  ])('lets %s through', href => {
    expect(isSafeLinkHref(href)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '/catalog/default/component/x',
    '//example.com/a',
    'example.com',
    '',
  ])('refuses %s', href => {
    expect(isSafeLinkHref(href)).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    expect(isSafeLinkHref(undefined)).toBe(false);
    expect(isSafeLinkHref({ toString: () => 'https://example.com' })).toBe(
      false,
    );
  });
});

describe('AiChatSafeLink', () => {
  it('links an https address in a new tab that is told nothing of the page', () => {
    render(
      <AiChatSafeLink href="https://example.com/a">payments</AiChatSafeLink>,
    );
    const link = screen.getByRole('link', { name: 'payments' });
    expect(link).toHaveAttribute('href', 'https://example.com/a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('links a mailto address and shows the address without children', () => {
    render(<AiChatSafeLink href="mailto:team@example.com" />);
    expect(
      screen.getByRole('link', { name: 'mailto:team@example.com' }),
    ).toHaveAttribute('href', 'mailto:team@example.com');
  });

  it('shows any other address as text, without a link', () => {
    render(
      <>
        <AiChatSafeLink href="javascript:alert(1)">run</AiChatSafeLink>
        <AiChatSafeLink href="/relative" />
        <AiChatSafeLink href={42} />
      </>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('run')).toBeInTheDocument();
    expect(screen.getByText('/relative')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(document.querySelector('[href]')).toBeNull();
  });
});
