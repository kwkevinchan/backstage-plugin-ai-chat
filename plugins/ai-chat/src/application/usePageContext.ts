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

import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import {
  isEntityRef,
  isPagePath,
  type ChatPageContext,
} from '@kwkevinchan/backstage-plugin-ai-chat-common';

/** The query parameter of the chat page that names the entity it opens for. */
export const ENTITY_REF_PARAM = 'entityRef';

/**
 * The page the user is on (B-01): the path, and the entity when the chat was
 * opened for one (`?entityRef=component:default/example`, the link that an
 * entity page gives). A link can carry any text, and the model reads what the
 * page sends, so a value that is not an entity reference, or a path that is not
 * a path, is left out: the chat goes on without it.
 */
export function usePageContext(): ChatPageContext {
  const { pathname, search } = useLocation();
  const entityRef =
    new URLSearchParams(search).get(ENTITY_REF_PARAM) ?? undefined;
  return useMemo(
    () => pageContextOf(pathname, entityRef),
    [pathname, entityRef],
  );
}

/** The page context for a path and an entity, with what does not pass the check left out. */
export function pageContextOf(
  path: string,
  entityRef?: string,
): ChatPageContext {
  return {
    path: isPagePath(path) ? path : '/',
    ...(entityRef && isEntityRef(entityRef) && { entityRef }),
  };
}
