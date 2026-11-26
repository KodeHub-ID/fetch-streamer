# Comparison with Native EventSource

| Capability | Native `EventSource` | Fetch Streamer |
|---|---|---|
| Custom headers | No | Yes |
| Bearer token auth | No | Yes |
| Share token auth | No | Yes |
| POST + body | No | Yes |
| Reconnect after a broken connection | Yes | Yes |
| Reconnect after the server completes the response | Yes | **No** — `onClose` fires; the caller decides |
| Exponential backoff | Optional for the browser | Yes |
| Backoff jitter | No | Yes |
| `Last-Event-ID` | Yes (auto) | Yes |
| `retry:` directive | Yes, until changed | Partial: clamped, kept until the next successful connection, ignored in a block without `data` |
| HTTP 204 | Stops | Stops |
| Other non-200 status or wrong content type | Stops | Retries, except 401, 403, 404, 405, 410, 422 |
| Max retries limit | No | Yes (`maxRetries` option) |
| Token refresh on reconnect | No | Yes (header provider) |
| Typed error classes | No (generic Event) | Yes |
| Buffer size guard | No | Yes (`maxBufferLength`) |
| Connection timeout | No | Yes (`connectTimeoutMs`, retriable) |
| Heartbeat timeout | No | Yes (`heartbeatTimeoutMs`, retriable) |
| Teardown signal | `.close()` | `.close()` + `AbortSignal` |
| CR/CRLF line endings | Yes (browser) | Yes (manual) |
| Zero dependencies | Yes | Yes |
| Works in Web Workers | Yes | Yes |
| SSR / Node.js | Not by default | Yes (requires `fetch` + `ReadableStream`) |

---

[← Integration Guide](./09-integration.md)
