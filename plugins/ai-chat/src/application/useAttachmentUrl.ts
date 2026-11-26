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

import { useEffect, useRef, useState } from 'react';

/**
 * An object URL for one image, loaded with the signed-in request. The URL is
 * revoked when the image changes and when the component unmounts, not on
 * every render around it. `failed` when the bytes cannot be read.
 */
export function useAttachmentUrl(
  id: string,
  load: (id: string) => Promise<Blob>,
): { url?: string; failed: boolean } {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [state, setState] = useState<{
    id: string;
    url?: string;
    failed: boolean;
  }>({ id, failed: false });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ id, failed: false });
    Promise.resolve()
      .then(() => loadRef.current(id))
      .then(blob => {
        const created = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(created);
          return;
        }
        objectUrl = created;
        setState({ id, url: created, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ id, failed: true });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  // The state of an earlier image is never shown for this one.
  if (state.id !== id) return { failed: false };
  return { url: state.url, failed: state.failed };
}

/** An object URL for a file of the user (a draft image), revoked when it changes or unmounts. */
export function useFileUrl(file: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) {
      setUrl(undefined);
      return undefined;
    }
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file]);
  return url;
}
