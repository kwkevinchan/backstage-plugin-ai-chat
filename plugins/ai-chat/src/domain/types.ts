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

import type { UIMessage } from 'ai';
import type {
  ChatAttachment,
  ChatDataParts,
  ChatReferenceInput,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { ShownReference } from './references';

/**
 * What the screen adds to an inserted message that the run ended without
 * reading: `sendAgain` is set when the message has a button of its own.
 */
export interface ChatUnreadData {
  seq: number;
  sendAgain: boolean;
}

/**
 * The data parts of the stream, in the shape that `UIMessage` takes, and
 * `unread`, which only the screen makes (from the stored items).
 */
export type ChatUiDataParts = {
  [K in keyof ChatDataParts]: ChatDataParts[K];
} & { unread: ChatUnreadData };

/** Images and references of a user message, kept on the message so the screen can draw them. */
export interface ChatMessageMetadata {
  attachments?: ChatAttachment[];
  /** As sent, or as the backend stored them. */
  references?: ShownReference[];
}

/**
 * What the input box sends: the text, the images that have been uploaded and
 * the references of the box. The text may be empty when there is at least
 * one image.
 */
export interface OutgoingMessage {
  text: string;
  attachments?: ChatAttachment[];
  references?: ChatReferenceInput[];
}

/** A message of the screen: a message of the AI SDK with the data parts of the chat. */
export type ChatUiMessage = UIMessage<ChatMessageMetadata, ChatUiDataParts>;

/** The part of a message that shows a tool call. */
export type ToolPart = Extract<
  ChatUiMessage['parts'][number],
  { toolCallId: string }
>;
