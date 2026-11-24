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
  checkImage,
  cleanAttachmentName,
  IMAGE_MEDIA_TYPES,
  isImageMediaType,
  type ImageMediaType,
} from './attachment';

/** The first bytes of a file of each type: all that the check looks at. */
const HEADERS: Record<ImageMediaType, Buffer> = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]),
  'image/webp': Buffer.from('RIFF\0\0\0\0WEBPVP8 '),
  'image/gif': Buffer.from('GIF89a\x01\x00'),
};

const OTHER_PAIRS = IMAGE_MEDIA_TYPES.flatMap(declared =>
  IMAGE_MEDIA_TYPES.filter(type => type !== declared).map(
    type => [declared, type] as const,
  ),
);

describe('checkImage (IN-02)', () => {
  it.each(IMAGE_MEDIA_TYPES)('accepts the header of a %s', type => {
    expect(checkImage(type, HEADERS[type])).toBe(true);
  });

  it.each(OTHER_PAIRS)(
    'refuses the type %s declared for the header of a %s',
    (declared, type) => {
      expect(checkImage(declared, HEADERS[type])).toBe(false);
    },
  );

  it('accepts both versions of GIF', () => {
    expect(checkImage('image/gif', Buffer.from('GIF87a....'))).toBe(true);
    expect(checkImage('image/gif', Buffer.from('GIF89a....'))).toBe(true);
    expect(checkImage('image/gif', Buffer.from('GIF88a....'))).toBe(false);
  });

  it('needs RIFF and WEBP at their places for WebP', () => {
    const riffOnly = Buffer.from('RIFF\0\0\0\0WAVEfmt ');
    expect(checkImage('image/webp', riffOnly)).toBe(false);
    expect(checkImage('image/webp', Buffer.from('RIFF\0\0\0\0WEBP'))).toBe(
      true,
    );
  });

  it('refuses bytes that are too short, empty, text and SVG', () => {
    expect(checkImage('image/png', HEADERS['image/png'].subarray(0, 7))).toBe(
      false,
    );
    expect(checkImage('image/jpeg', Buffer.alloc(0))).toBe(false);
    expect(checkImage('image/png', Buffer.from('<svg></svg>'))).toBe(false);
  });
});

describe('isImageMediaType', () => {
  it('knows the four types and not SVG', () => {
    expect(IMAGE_MEDIA_TYPES.every(isImageMediaType)).toBe(true);
    expect(isImageMediaType('image/svg+xml')).toBe(false);
    expect(isImageMediaType('IMAGE/PNG')).toBe(false);
  });
});

describe('cleanAttachmentName', () => {
  it('removes control characters and replaces path separators', () => {
    expect(cleanAttachmentName('a\u0000b\nc.png')).toBe('abc.png');
    expect(cleanAttachmentName('../etc/passwd')).toBe('.._etc_passwd');
    expect(cleanAttachmentName('C:\\dir\\x.png')).toBe('C:_dir_x.png');
  });

  it('cuts to 255 characters, and gives nothing for a name with nothing left', () => {
    expect(cleanAttachmentName('x'.repeat(300))).toHaveLength(255);
    expect(cleanAttachmentName('\n\t ')).toBeUndefined();
    expect(cleanAttachmentName('')).toBeUndefined();
  });
});
