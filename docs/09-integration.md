# Integration Guide

## 9.1 Installing

```bash
npm install @kodehub.id/fetch-streamer
```

ESM-only; requires a runtime with global `fetch` + `ReadableStream` (Node.js 18+, modern browsers, Web Workers). Or copy `src/` directly into any project that compiles TypeScript from source.

## 9.2 Basic Usage (Bearer Token)

```ts
import { FetchStreamer } from '@kodehub.id/fetch-streamer';

const token = await firebaseUser.getIdToken();

const stream = new FetchStreamer('/api/stream/devices', {
  headers: { Authorization: `Bearer ${token}` },
  onMessage(event) {
    if (event.type === 'device.update') {
      const payload = JSON.parse(event.data) as unknown;
      // validate + update state
    }
  },
  onError(err) {
    console.error('[SSE]', err);
  },
});

// Teardown
stream.close();
```

## 9.3 Share Token (No Reconnect on Auth Failure)

```ts
import { FetchStreamer, FetchStreamerHttpError } from '@kodehub.id/fetch-streamer';

const stream = new FetchStreamer('/api/stream/shared', {
  headers: { 'X-Share-Token': shareToken },
  reconnectOnError: false,
  onMessage(event) { /* ... */ },
  onError(err) {
    if (err instanceof FetchStreamerHttpError && err.status === 401) {
      showAccessRevokedBanner();
    }
  },
});
```

## 9.4 Firebase Token Auto-Refresh

Firebase ID tokens expire after 1 hour. Pass a **header provider** so every connection
attempt — including the library's own internal reconnects — fetches a current token.
`getIdToken()` (no force flag) returns the cached token and transparently refreshes it
when it is expired or near expiry, so reconnects never reuse a stale credential and you
never manually restart the instance on a 401:

```ts
import { FetchStreamer } from '@kodehub.id/fetch-streamer';
import { auth } from '@/lib/firebase';

const stream = new FetchStreamer('/api/stream/devices', {
  // Re-evaluated per attempt. getIdToken() auto-refreshes an expired token.
  headers: async () => {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('signed out'); // → retriable failure, reported to onError
    return { Authorization: `Bearer ${token}` };
  },
  onMessage(event) { /* ... */ },
});

// Teardown
stream.close();
```

A 401/403 here means the freshly-resolved token was genuinely rejected (revoked/disabled),
not merely expired — so it remains non-retriable and stops reconnection. Because resolution
runs under the connect signal, a slow `getIdToken()` is bounded by `connectTimeoutMs` and
interrupted by `close()`.

## 9.5 React Hook Wrapper

Callbacks (`onMessage`, `onError`, etc.) are proxied through a ref so they never go stale. Configuration options are snapshot at mount — add changed values to `deps` to trigger a reconnect with new config. A rotated auth token does **not** belong in `deps`: use a [header provider](#94-firebase-token-auto-refresh) so each attempt resolves the current token without reopening the stream.

```ts
// src/app/hooks/useSSE.ts
import { useEffect, useRef } from 'react';
import { FetchStreamer } from '@kodehub.id/fetch-streamer';
import type { FetchStreamerOptions } from '@kodehub.id/fetch-streamer';

export function useSSE(
  url: string | null,
  options: FetchStreamerOptions,
  deps: readonly unknown[] = [],
): void {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!url) return;

    const { onOpen, onMessage, onError, onClose, ...staticConfig } = latest.current;

    const stream = new FetchStreamer(url, {
      ...staticConfig,
      onOpen:    (res)   => latest.current.onOpen?.(res),
      onMessage: (event) => latest.current.onMessage?.(event),
      onError:   (err)   => latest.current.onError?.(err),
      onClose:   ()      => latest.current.onClose?.(),
    });

    return () => stream.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
}
```

Usage:

```ts
// Token resolved per attempt via a provider — no reopen on rotation, so no token dep.
useSSE(
  '/api/stream/devices',
  { headers: async () => ({ Authorization: `Bearer ${await getToken()}` }), onMessage(e) { ... } },
  [],
);
```

## 9.6 Backend Requirements

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` is required for nginx — without it, nginx buffers the stream and events are delivered in large batches rather than individually.

---

[← Known Limitations](./08-limitations.md) | [Next: Comparison →](./10-comparison.md)
