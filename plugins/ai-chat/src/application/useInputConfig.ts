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

import { useEffect, useState } from 'react';
import type { ChatInputConfig } from '@kwkevinchan/backstage-plugin-ai-chat-common';
import type { AiChatApi } from '../api';

/**
 * What a message may carry. `undefined` until the answer arrives, and when the
 * request fails: the box then shows no attach button.
 */
export function useInputConfig(api: AiChatApi): ChatInputConfig | undefined {
  const [config, setConfig] = useState<ChatInputConfig>();
  useEffect(() => {
    let cancelled = false;
    api.getInputConfig().then(
      value => {
        if (!cancelled) setConfig(value);
      },
      () => {
        // No config: the box stays without an attach button.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  return config;
}
