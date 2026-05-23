# Security Considerations

## 5.1 Server-sent `retry:` is clamped, not trusted

Fetch Streamer clamps all `retry:` values from the server between `minRetryMs` and `maxRetryMs` before applying them. A compromised server cannot force either a `retry: 0` tight-loop that floods the server with requests, or a `retry: 86400000` (24 h) that silently blocks reconnection:

```ts
this.retryMs = Math.min(
  Math.max(parsed.retry, this.cfg.minRetryMs),
  this.cfg.maxRetryMs,
);
```

Default range: 500 ms – 30 s. Adjust `minRetryMs` / `maxRetryMs` in options to tighten the bounds for your use case.

## 5.2 SSE buffer is bounded

The parser accumulates incoming chunks until it sees a blank-line event boundary. To prevent a server that never sends boundaries from growing this buffer to OOM, the library enforces `maxBufferLength` (default: 1,048,576 code units). When exceeded, the buffer is discarded and `FetchStreamerBufferError` is emitted via `onError`, triggering the normal reconnect path.

## 5.3 HTTP errors expose only status code, not response headers

On non-2xx responses, the library throws `FetchStreamerHttpError(status, statusText)` — a plain object containing only the numeric status and text phrase. The raw `Response` object (which carries headers such as `Set-Cookie` or internal trace IDs) is never forwarded to `onError`, ensuring sensitive header values never reach the caller's error handler or external monitoring systems.

## 5.4 External `AbortSignal` listener is self-cleaning

When `options.signal` is provided, the abort listener is registered with `{ once: true }` **and** explicitly removed inside `close()`. Both paths matter:

- If the signal aborts, `{ once: true }` drops the listener after it fires.
- If the stream is closed any other way (`close()`, a non-retriable error, clean server close), `close()` calls `removeEventListener` so the listener — which captures `this` — does not linger on a caller-owned signal that may outlive the stream. Relying on `{ once: true }` alone would leak the instance until the signal eventually aborted.

Likewise, the interruptible backoff (`sleep()`) detaches its abort listener on normal completion, so repeated reconnects do not accumulate one listener per retry on the shared internal signal.

## 5.5 Backoff includes jitter

Reconnect intervals are randomised by ±25% so a mass server restart does not cause all clients to reconnect at the same instant. The jittered delay is floored at `minRetryMs`, so negative jitter can never undercut the configured minimum and produce a tight reconnect loop:

```ts
const jitter = (Math.random() - 0.5) * 0.5 * this.retryMs;
const delay = Math.max(this.cfg.minRetryMs, this.retryMs + jitter);
await this.sleep(delay);
```

## 5.6 `event.data` is caller-validated, not library-validated

The library delivers `event.data` as a raw string exactly as the server sent it. Validation is the caller's responsibility — never pass the value directly to `innerHTML`, `eval()`, or `Function()`:

```ts
onMessage(event) {
  const payload = JSON.parse(event.data) as unknown;
  if (!isDeviceUpdate(payload)) return;
}
```

A throwing `onMessage` (e.g. the `JSON.parse` above on malformed data) is caught and routed to `onError`; it cannot crash the read loop or trigger an unwanted reconnect. See [Implementation Decisions §6.14](./06-implementation.md#614-handler-exception-isolation).

---

[← API Reference](./04-api-reference.md) | [Next: Implementation Decisions →](./06-implementation.md)
