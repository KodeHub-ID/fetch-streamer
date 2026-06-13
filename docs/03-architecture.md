# Architecture

## File Structure

```
fetch-streamer/
├── src/
│   ├── index.ts          ← public API (re-exports only)
│   ├── types.ts          ← SSEEvent, FetchStreamerOptions
│   ├── errors.ts         ← FetchStreamerHttpError, ContentTypeError, BufferError, ConnectTimeoutError, HeartbeatError
│   ├── parser.ts         ← streaming SSE text parser
│   └── FetchStreamer.ts  ← core class (connection loop, reconnect, teardown)
├── docs/                 ← technical documentation
├── README.md             ← project overview and quick start
├── package.json
└── tsconfig.json
```

## Dependency Graph

```
index.ts
  └── FetchStreamer.ts
        ├── parser.ts
        │     └── errors.ts (FetchStreamerBufferError)
        ├── errors.ts (FetchStreamerHttpError, FetchStreamerContentTypeError, FetchStreamerConnectTimeoutError, FetchStreamerHeartbeatError)
        └── types.ts
```

No circular dependencies. `errors.ts` and `types.ts` are leaves.

## Class Lifecycle

```
new FetchStreamer(url, options)
  │
  ├─ resolves all numeric options → this.cfg  (single source of truth, no ?? at call sites)
  ├─ wires caller's AbortSignal → this.close()  [{ once: true }; honours pre-aborted signal]
  └─ void this.run()  ← skipped if signal already aborted; this.close() called instead
        │
        ├─ [loop] while (!this.closed)
        │     └─ await this.openConnection()
        │           ├─ this.buildConnectSignal()    ← merge close() signal + connectTimeoutMs timer
        │           ├─ await this.resolveHeaders(signal)  ← static headers, or a provider raced
        │           │         against the signal (close()/timeout interrupt a hanging provider)
        │           ├─ fetch(url, { signal })       ← aborts on close() or connect timeout
        │           ├─ validate response.ok + Content-Type
        │           ├─ await onOpen?.(response)
        │           ├─ guard: if (this.closed) return  ← close() during onOpen
        │           ├─ reset retryMs + retryCount
        │           └─ await this.readStream(reader)
        │                 ├─ abort listener: this.abortController → reader.cancel()  ← close() path
        │                 ├─ heartbeat timer: reset on every chunk; cancel() reader on expire
        │                 ├─ [loop] reader.read() → decoder → push(chunk)
        │                 │         └─ this.handleParsedEvent(parsed)
        │                 │               ├─ update lastEventId
        │                 │               ├─ update retryMs (clamped min/max)
        │                 │               └─ onMessage?.(SSEEvent)  ← try/catch → emitError (isolated)
        │                 ├─ on done: push(decoder.decode())  ← flush trailing bytes
        │                 ├─ finally: removeEventListener(onAbort) + clearTimeout(heartbeatTimer) + await reader.cancel()
        │                 └─ post-finally: throw FetchStreamerHeartbeatError if timer fired
        │
        └─ on error:
              ├─ emitError(err)  ← onError?.(err) wrapped in try/catch
              ├─ this.shouldGiveUp(err)  ← reconnectOnError / non-retriable / maxRetries
              ├─ await this.sleep(max(minRetryMs, retryMs + jitter))  ← interruptible via AbortSignal
              └─ retryMs = min(retryMs * 1.5, cfg.maxRetryMs)

this.close()
  ├─ this.closed = true
  ├─ this.abortController.abort()   ← cancels in-flight fetch AND wakes up sleep()
  └─ onClose?.()  ← wrapped in try/catch (idempotent; guarded against a throwing handler)
```

---

[← SSE Wire Format](./02-sse-format.md) | [Next: API Reference →](./04-api-reference.md)
