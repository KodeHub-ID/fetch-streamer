# Implementation Decisions

## 6.1 Interruptible Sleep

`close()` must be able to interrupt a sleeping backoff immediately — otherwise a component that unmounts during a 30 s backoff holds a live reference until the timer fires.

The `AbortController`'s signal is wired directly into the sleep promise, so calling `close()` wakes it up instantly. The abort listener is detached on the normal-completion path too, so a long run of reconnects does not pile up one listener per retry on the shared signal:

```ts
private sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const signal = this.abortController.signal;
    let id: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort); // detach on normal completion
      resolve();
    }, Math.min(Math.max(0, ms), MAX_TIMER_MS)); // larger delays would fire at once
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

## 6.2 `try/finally` Around Reader

If `reader.read()` throws mid-stream (network drop, abort), the `ReadableStream` reader must still be explicitly released — otherwise the browser keeps the stream locked until GC runs.

The reader is cancelled (through `cancelReader()`, see [§6.12](#612-direct-abort-listener-in-readstream)) in a `finally` block, covering all exit paths: clean server close, thrown error, and `close()` called mid-read.

## 6.3 Non-Retriable Status Codes

The following HTTP status codes are never retried, because reconnecting is pointless or unwanted:

| Status | Reason |
|---|---|
| 204 | The server is telling the client to stop (the SSE convention) |
| 401 | Authentication required — token is missing or expired |
| 403 | Authorization denied — token lacks permission |
| 404 | Endpoint does not exist |
| 405 | Method not allowed |
| 410 | Resource permanently gone |
| 422 | Unprocessable — client sent invalid parameters |

5xx errors (server-side) and network failures are always retriable.

## 6.4 Server Clean-Close vs. Error

When the server intentionally closes the stream (`done === true` from `reader.read()`), we call `this.close()` and stop — a clean server-side close is an intentional signal, not an error worth retrying.

If callers need reconnect-on-clean-close behavior (e.g., server periodically rotates streams), implement it by creating a new `FetchStreamer` instance in `onClose`.

## 6.5 `onOpen` is Awaited

`onOpen` is `async`-compatible so callers can perform async setup before message processing begins. If `onOpen` throws, the error propagates to the reconnect loop.

`onOpen` is awaited before the reader is created, so a guard checks `this.closed` immediately after — ensuring teardown requested during `onOpen` is honoured without creating a reader that would be immediately discarded:

```ts
await this.options.onOpen?.(response);
if (this.closed) return;
```

## 6.6 Option Normalization at Construction (`ResolvedConfig`)

All numeric options are resolved once in the constructor and stored in an internal `cfg` object, so methods never repeat default or range handling. `delayOption()` and `timeoutOption()` treat `null` and `''` as unset, convert numeric strings (untyped callers pass both), and keep values within what a timer accepts:

```ts
this.cfg = {
  reconnectOnError:   options.reconnectOnError   ?? true,
  maxRetries:         options.maxRetries,
  initialRetryMs:     delayOption(options.initialRetryMs, DEFAULTS.initialRetryMs),
  maxRetryMs:         delayOption(options.maxRetryMs, DEFAULTS.maxRetryMs),
  minRetryMs:         delayOption(options.minRetryMs, DEFAULTS.minRetryMs),
  maxBufferLength:    options.maxBufferLength ?? DEFAULTS.maxBufferLength,
  connectTimeoutMs:   timeoutOption(options.connectTimeoutMs),
  heartbeatTimeoutMs: timeoutOption(options.heartbeatTimeoutMs),
};
```

HTTP request options (`headers`, `method`, `body`, `withCredentials`) and callbacks are read from `this.options` directly on each reconnect — keeping them live without requiring a new instance.

## 6.7 Lifetime and Per-Attempt AbortControllers

One `AbortController` is created at construction and shared across all reconnect cycles; each connection attempt also gets its own, linked to it (§6.9). The lifetime controller is only aborted via `close()`. Since `close()` sets `this.closed = true` before calling `abort()`, the `this.closed` flag alone is sufficient in the error handler — a separate `signal.aborted` check would always be redundant.

## 6.8 `Last-Event-ID` Header Casing

The spec uses `Last-Event-ID` (with hyphens, mixed case). HTTP/2 lowercases all headers, but the server-side framework is responsible for normalizing. We send the canonical form.

## 6.9 Connection Timeout Without `AbortSignal.any()`

Each attempt gets its own `AbortController` from `buildAttempt()`, and its signal is passed to `fetch()`. Two abort sources feed into it:

1. **Timeout**: a `setTimeout` calls `abort(new FetchStreamerConnectTimeoutError(timeoutMs))`. The timer is cleared by `connected()` once response headers arrive.
2. **Close propagation**: an `abort` listener on `this.abortController.signal` forwards `close()`. It stays attached for the **whole response**, body included.

`dispose()` runs in a `finally` when the attempt ends for any reason (error status, wrong content type, a throwing `onOpen`, a read error, a clean end). It removes the listener and aborts the request, so a retry never leaves the previous connection open.

`AbortSignal.any()` would be the natural fit, but it requires Node.js 20+ and Chrome 116+. The listener-based propagation achieves identical semantics with universal compatibility (Node.js 18+, all modern browsers).

When the timeout fires, the attempt signal's `reason` is `FetchStreamerConnectTimeoutError`. The catch block in `runAttempt()` inspects this to rethrow the typed error rather than the generic `DOMException` that `fetch()` surfaces on abort.

`FetchStreamerConnectTimeoutError` is retriable — it follows the same path as a network failure, with exponential backoff and jitter.

The connect signal is built **before** header resolution, so it bounds the whole attempt — not just `fetch()`. `resolveHeaders()` races a header provider against the same signal, so a provider that hangs (e.g. a stuck token refresh) is interrupted by the connect timeout or by `close()` rather than blocking the attempt indefinitely. A provider that settles after the abort is ignored, so no stray request is fired.

## 6.10 Heartbeat Timeout: Post-`finally` Throw Pattern

The heartbeat timer is started before the `reader.read()` loop and reset on every received chunk. When it fires, it sets a `heartbeatExpired` flag and calls `void cancelReader()` — this causes `reader.read()` to resolve with `{ done: true }`, ending the loop normally. The `finally` block runs as usual (`clearTimeout` + `cancelReader()`, idempotently).

`FetchStreamerHeartbeatError` is thrown **after** the `finally` block, not inside the loop. This guarantees the reader is always released before the error propagates to the reconnect loop, regardless of the timeout path.

```ts
try {
  while (!this.closed) {
    const { done, value } = await reader.read();
    if (done) break;
    resetHeartbeat();
    push(decoder.decode(value, { stream: true }));
  }
} finally {
  this.abortController.signal.removeEventListener('abort', onAbort);
  clearTimeout(heartbeatTimer);
  await cancelReader();
}

if (heartbeatExpired && heartbeatTimeoutMs !== undefined) {
  throw new FetchStreamerHeartbeatError(heartbeatTimeoutMs);
}
```

## 6.11 Pre-Aborted Signal Guard

`addEventListener` does not fire retroactively. If a caller passes `options.signal` that is already `signal.aborted === true` at construction time, the registered `abort` listener will never fire, and the run loop would start as if no signal was provided.

To handle this, the constructor checks `signal.aborted` explicitly after registering the listener:

```ts
options.signal?.addEventListener('abort', this.onExternalAbort, { once: true });
if (options.signal?.aborted) {
  this.close();
} else {
  void this.run();
}
```

This covers the common React pattern where a signal from a parent `AbortController` may already be aborted at the time the component re-renders and re-creates the stream.

## 6.12 Direct Abort Listener in `readStream()`

Because `close()` aborts the request, the body stream is usually already errored by the time the reader is cancelled, and `reader.cancel()` then rejects. Every cancel therefore goes through `cancelReader()`, which swallows that rejection; left unhandled it would terminate a Node.js process. The separate `abort` listener that cancels the reader remains for `fetch` implementations that do not error the body on abort.

## 6.13 `maxBufferLength`: Measuring in UTF-16 Code Units

The limit is checked against JS string `.length` of the pending event — UTF-16 code units, the native unit of JS strings — rather than raw UTF-8 bytes. This is a deliberate choice.

The accurate alternative would track a running byte counter using `new TextEncoder().encode(chunk).byteLength` on each incoming chunk (encoding only the new chunk, not the whole buffer). This preserves O(n) complexity but `TextEncoder.encode()` always allocates a new `Uint8Array` — for every chunk, regardless of size. For an OOM guard that fires at most once per connection attempt, that per-chunk heap allocation is unnecessary overhead. Code-unit measurement is O(1) with zero allocation.

Because data arrives as UTF-8 and is decoded by `TextDecoder` before entering the buffer, the code-unit count is not always equal to the wire byte count:

| Character category | Example | UTF-8 bytes (wire) | UTF-16 code units (`.length`) | Ratio |
|---|---|---|---|---|
| ASCII | `A` `{` `0` | 1 | 1 | 1:1 |
| Latin extended | `é` `ñ` | 2 | 1 | 2:1 |
| CJK, common symbols | `中` `€` `→` | 3 | 1 | 3:1 |
| Emoji, supplementary | `😀` `𝄞` | 4 | 2 | 2:1 |

For the typical case — ASCII-only SSE payloads — the limit is exact. For non-ASCII streams the guard fires later than the raw byte count would, but still within a small constant factor (2–3×), which is acceptable for protecting against unbounded growth.

The option is named `maxBufferLength` rather than `maxBufferBytes` precisely to surface this at the API level, so callers set expectations against code units, not bytes.

## 6.14 Handler Exception Isolation

`onMessage` runs once per dispatched event, deep inside the `reader.read()` loop. If it threw, the exception would propagate out of the loop, be caught by the reconnect handler in `run()`, and be treated as a *connection* failure — silently reconnecting because of a bug in the consumer's event handling.

To prevent that, `onMessage` is wrapped: its exceptions are caught and forwarded to `onError`, but the read loop continues uninterrupted.

```ts
if (parsed.id !== undefined) this.lastEventId = parsed.id;
// ...retry clamp...
try {
  this.options.onMessage?.({ type, data, lastEventId: this.lastEventId });
} catch (err) {
  this.emitError(err);
}
```

`lastEventId` and `retryMs` are updated *before* the call, so they remain correct even if the handler throws.

Callbacks are typed as returning `void`, which still admits an `async` function, so a returned promise is watched too: a rejecting `onMessage` goes to `onError` (not after the caller's own `close()`), and rejections from `onError` or `onClose` are swallowed.

`onError` and `onClose` are likewise hardened against their own exceptions: `emitError()` wraps `onError` in a `try/catch`, and `close()` wraps `onClose`. A throwing notification handler cannot break reconnection (an escaped throw from `run()` would become an unhandled rejection) or leave the instance half-closed. There is no further channel to report a bug in the error/close handler itself, so those exceptions are swallowed.

**`onOpen` is deliberately *not* isolated** — see [§6.5](#65-onopen-is-awaited). It guards setup that must succeed before message processing, so a throw there is a legitimate reason to fail the attempt and retry.

## 6.15 Final Decoder Flush

The body bytes are decoded with `new TextDecoder().decode(value, { stream: true })`, which buffers a trailing partial multi-byte sequence until the bytes that complete it arrive in a later chunk. When the stream ends cleanly (`done === true`), a final no-argument `decode()` flushes anything still held back, so no decoded text is silently dropped at the end of a stream:

```ts
const { done, value } = await reader.read();
if (done) {
  push(decoder.decode()); // flush
  break;
}
```

---

[← Security](./05-security.md) | [Next: Parser Compliance →](./07-parser.md)
