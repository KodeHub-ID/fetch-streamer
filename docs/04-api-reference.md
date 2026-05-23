# API Reference

## `new FetchStreamer(url, options?)`

Starts the SSE connection immediately. No explicit `.connect()` call needed.

```ts
import { FetchStreamer } from '@kodehub.id/fetch-streamer';

const stream = new FetchStreamer('/api/events', {
  headers: { Authorization: `Bearer ${token}` },
  onMessage(event) {
    console.log(event.type, event.data);
  },
});
```

## `FetchStreamerOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `headers` | `Record<string, string>` | `{}` | Extra request headers. Merged first — required headers (`Accept`, `Cache-Control`) are set after and cannot be overridden. |
| `method` | `'GET' \| 'POST'` | `'GET'` | HTTP method. |
| `body` | `string` | — | Request body. Only used with `POST`. |
| `withCredentials` | `boolean` | `false` | Send cookies on cross-origin requests. |
| `reconnectOnError` | `boolean` | `true` | Retry after connection failure. |
| `maxRetries` | `number` | unlimited | Maximum retry attempts before permanently closing. |
| `initialRetryMs` | `number` | `3000` | Initial backoff delay in ms. |
| `maxRetryMs` | `number` | `30000` | Backoff ceiling in ms. |
| `minRetryMs` | `number` | `500` | Lower bound for reconnect delay — floors server-sent `retry:` values and the jittered backoff. |
| `maxBufferLength` | `number` | `1048576` | SSE text buffer size limit in UTF-16 code units (`buffer.length`). Equals bytes for ASCII; for CJK/emoji the actual byte limit is higher — see [Implementation Decisions §6.13](./06-implementation.md#613-maxbufferlength-measuring-in-utf-16-code-units). |
| `connectTimeoutMs` | `number` | — | Max ms to wait for `fetch()` to resolve. Throws `FetchStreamerConnectTimeoutError` then retries with backoff. No timeout by default. |
| `heartbeatTimeoutMs` | `number` | — | Max ms of silence between chunks. Throws `FetchStreamerHeartbeatError` then retries with backoff. No timeout by default. |
| `onOpen` | `(res: Response) => void \| Promise<void>` | — | Called after successful connection. |
| `onMessage` | `(event: SSEEvent) => void` | — | Called per dispatched SSE event. |
| `onError` | `(error: unknown) => void` | — | Called on any connection error. |
| `onClose` | `() => void` | — | Called when permanently closed. |
| `signal` | `AbortSignal` | — | External teardown signal. |

## `SSEEvent`

```ts
interface SSEEvent {
  type: string;        // event type name ("message" by default)
  data: string;        // raw data payload
  lastEventId: string; // accumulated last event ID
}
```

## `stream.close()`

Permanently closes the stream. Idempotent — safe to call multiple times. Cancels any in-progress fetch and wakes up any sleeping backoff immediately.

## Error Classes

```ts
// Non-2xx HTTP response
class FetchStreamerHttpError extends Error {
  status: number;
  statusText: string;
}

// Response Content-Type was not text/event-stream
class FetchStreamerContentTypeError extends Error {
  contentType: string | null;
}

// SSE text buffer exceeded maxBufferLength
class FetchStreamerBufferError extends Error {
  limitLength: number;
}

// fetch() did not resolve within connectTimeoutMs
class FetchStreamerConnectTimeoutError extends Error {
  timeoutMs: number;
}

// No chunk received within heartbeatTimeoutMs
class FetchStreamerHeartbeatError extends Error {
  timeoutMs: number;
}
```

---

[← Architecture](./03-architecture.md) | [Next: Security →](./05-security.md)
