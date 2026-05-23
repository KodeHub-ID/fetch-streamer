# Fetch Streamer

Zero-dependency SSE client using `fetch` + `ReadableStream`. Spec-compliant drop-in for `EventSource` with custom header support, exponential backoff, and full TypeScript types.

Works in browsers, Node.js 18+, Web Workers, and SSR environments.

## Why not native `EventSource`?

Browsers prohibit setting custom headers on `EventSource` requests. If your API uses Bearer tokens, API keys, or share tokens — `EventSource` won't work. Fetch Streamer solves this by using the `fetch` API, which has no header restrictions, while manually implementing the full SSE parsing and reconnect logic.

## Installation

```json
{
  "dependencies": {
    "@kodehub.id/fetch-streamer": "file:../fetch-streamer"
  }
}
```

## Quick Start

```ts
import { FetchStreamer } from '@kodehub.id/fetch-streamer';

const stream = new FetchStreamer('/api/events', {
  headers: { Authorization: `Bearer ${token}` },
  onMessage(event) {
    console.log(event.type, event.data);
  },
  onError(err) {
    console.error('[SSE]', err);
  },
  onClose() {
    console.log('stream closed');
  },
});

// Teardown
stream.close();
```

## Key Features

- **Custom headers** — Bearer tokens, API keys, share tokens on every request including reconnects
- **Exponential backoff with jitter** — configurable delay, ceiling, and ±25% randomisation to prevent thundering herd
- **Typed error classes** — `FetchStreamerHttpError`, `FetchStreamerContentTypeError`, `FetchStreamerBufferError`, `FetchStreamerConnectTimeoutError`, `FetchStreamerHeartbeatError`
- **Connection timeout** — abort `fetch()` if the server is slow to respond (`connectTimeoutMs`)
- **Heartbeat timeout** — detect a silent stream and reconnect (`heartbeatTimeoutMs`)
- **Security guards** — server `retry:` values are clamped; buffer size is bounded; HTTP error details never leak to loggers
- **WHATWG spec compliant** — line-oriented parser handling CR/LF/CRLF and mixed-style boundaries (incl. CRLF split across chunks); correct `id:` empty-value semantics; strict `retry:` digit validation
- **`AbortSignal` support** — wire up React `useEffect` cleanup or any external signal
- **POST support** — stream over POST with a static body
- **Zero dependencies** — no polyfills, no bundler magic

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `headers` | `Record<string, string>` | `{}` | Extra request headers |
| `method` | `'GET' \| 'POST'` | `'GET'` | HTTP method |
| `body` | `string` | — | Request body (POST only) |
| `withCredentials` | `boolean` | `false` | Send cookies on cross-origin requests |
| `reconnectOnError` | `boolean` | `true` | Retry after connection failure |
| `maxRetries` | `number` | unlimited | Maximum retry attempts |
| `initialRetryMs` | `number` | `3000` | Initial backoff delay in ms |
| `maxRetryMs` | `number` | `30000` | Backoff ceiling in ms |
| `minRetryMs` | `number` | `500` | Lower bound for reconnect delay (floors server-sent `retry:` and jittered backoff) |
| `maxBufferLength` | `number` | `1048576` | SSE text buffer size limit in UTF-16 code units |
| `connectTimeoutMs` | `number` | — | Max ms to wait for `fetch()` to resolve |
| `heartbeatTimeoutMs` | `number` | — | Max ms of silence between chunks |
| `onOpen` | `(res: Response) => void \| Promise<void>` | — | Called after successful connection |
| `onMessage` | `(event: SSEEvent) => void` | — | Called per dispatched SSE event |
| `onError` | `(error: unknown) => void` | — | Called on any connection error |
| `onClose` | `() => void` | — | Called when permanently closed |
| `signal` | `AbortSignal` | — | External teardown signal |

## React Hook

```ts
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

Usage — reconnects automatically when `token` changes:

```ts
useSSE(
  '/api/stream/devices',
  { headers: { Authorization: `Bearer ${token}` }, onMessage(e) { ... } },
  [token],
);
```

## Error Handling

```ts
import {
  FetchStreamer,
  FetchStreamerHttpError,
  FetchStreamerConnectTimeoutError,
  FetchStreamerHeartbeatError,
} from '@kodehub.id/fetch-streamer';

const stream = new FetchStreamer(url, {
  connectTimeoutMs: 5_000,
  heartbeatTimeoutMs: 30_000,
  onError(err) {
    if (err instanceof FetchStreamerHttpError) {
      console.error('HTTP error', err.status, err.statusText);
    } else if (err instanceof FetchStreamerConnectTimeoutError) {
      console.warn('Connect timed out, retrying...');
    } else if (err instanceof FetchStreamerHeartbeatError) {
      console.warn('No data for', err.timeoutMs, 'ms, retrying...');
    }
  },
});
```

## Backend Requirements

Your server must respond with:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no   ← required if behind nginx
```

## Documentation

| Document | Contents |
|---|---|
| [Background & Motivation](./docs/01-background.md) | Why Fetch Streamer exists and what it improves over native `EventSource` |
| [SSE Wire Format](./docs/02-sse-format.md) | WHATWG spec line endings, fields, dispatch rules |
| [Architecture](./docs/03-architecture.md) | File structure, dependency graph, class lifecycle diagram |
| [API Reference](./docs/04-api-reference.md) | Full options table, `SSEEvent` type, error classes |
| [Security](./docs/05-security.md) | Buffer bounds, retry clamping, header leak prevention, jitter |
| [Implementation Decisions](./docs/06-implementation.md) | Design rationale — interruptible sleep, `ResolvedConfig`, post-`finally` throw |
| [Parser Compliance](./docs/07-parser.md) | WHATWG compliance details — line endings, `id:` semantics, `retry:` validation |
| [Known Limitations](./docs/08-limitations.md) | Page visibility, online/offline, static POST body |
| [Integration Guide](./docs/09-integration.md) | Usage examples — Firebase, share tokens, React hook, nginx config |
| [Comparison](./docs/10-comparison.md) | Feature matrix vs. native `EventSource` |

## License

MIT
