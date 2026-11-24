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

/** The formats of an image the chat takes (IN-01). SVG and any other format that can run content are not among them. */
export const IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/** What the host knows about an image of a session, without its bytes. */
export type AttachmentMeta = {
  id: string;
  sessionId: string;
  mediaType: ImageMediaType;
  /** For display and for the model to read; never used as a path. */
  name: string;
  size: number;
  sha256: string;
};

/** The limits on images (IN-01, IN-04, IN-06), from `aiChat.input.images`. */
export type ImageLimits = {
  /** Most images in one message. */
  maxPerMessage: number;
  /** Largest image, in bytes. */
  maxBytes: number;
  /** Most image bytes in the user messages of one run, and in one model input. */
  maxBytesPerInput: number;
  /** Most images of a session that are in no message yet. */
  maxPendingPerSession: number;
  /** What an image counts in the context budget. */
  tokensPerImage: number;
};

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxPerMessage: 4,
  maxBytes: 5 * 1024 * 1024,
  maxBytesPerInput: 20 * 1024 * 1024,
  maxPendingPerSession: 12,
  tokensPerImage: 1600,
};

/** An unused attachment is deleted after this many hours (IN-04). */
export const ATTACHMENT_TTL_HOURS = 24;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, mark: number[], at = 0): boolean {
  return (
    bytes.length >= at + mark.length &&
    mark.every((b, i) => bytes[at + i] === b)
  );
}

const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));

/**
 * Whether the start of `bytes` is the start of a file of the type `mediaType`
 * says (IN-02). It looks at the header only, and does not decode the image.
 */
export function checkImage(
  mediaType: ImageMediaType,
  bytes: Uint8Array,
): boolean {
  switch (mediaType) {
    case 'image/png':
      return startsWith(bytes, PNG);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return (
        startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))
      );
    case 'image/webp':
      // RIFF, the length of the chunk (4 bytes), WEBP.
      return (
        startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)
      );
    default:
      return mediaType satisfies never;
  }
}

const MAX_NAME_LENGTH = 255;

/**
 * The name of an attachment as it is stored: control characters removed, path
 * separators replaced by `_`, at most 255 characters. Returns `undefined` when
 * nothing is left.
 */
export function cleanAttachmentName(name: string): string | undefined {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : undefined;
}
