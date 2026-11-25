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
  createBackendModule,
  createExtensionPoint,
  type ExtensionPoint,
} from '@backstage/backend-plugin-api';
import { signalsServiceRef } from '@backstage/plugin-signals-node';
import type { Notifier } from './application/ports';
import { SignalsNotifier } from './adapters/backstage/SignalsNotifier';

/**
 * Where the Signals module installs the notifier. The plugin registers it.
 * The service ref is not a dependency of the plugin: Backstage 1.56 has no
 * optional service, so a plugin that required Signals would not start without
 * it.
 */
export interface AiChatSignalsExtension {
  setNotifier(notifier: Notifier): void;
}

/** @internal */
export const aiChatSignalsExtensionPoint: ExtensionPoint<AiChatSignalsExtension> =
  createExtensionPoint<AiChatSignalsExtension>({
    id: 'ai-chat.signals',
  });

/**
 * Publishes session activity on the Signals channel `ai-chat` when the
 * Signals backend is installed. Add it next to the plugin. Without this
 * module the plugin does not call Signals, and the page polls the session
 * list.
 *
 * @public
 */
export const aiChatSignalsModule = createBackendModule({
  pluginId: 'ai-chat',
  moduleId: 'signals',
  register(env) {
    env.registerInit({
      deps: {
        signals: signalsServiceRef,
        aiChat: aiChatSignalsExtensionPoint,
      },
      async init({ signals, aiChat }) {
        aiChat.setNotifier(new SignalsNotifier(signals));
      },
    });
  },
});
