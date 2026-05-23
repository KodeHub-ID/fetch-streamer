# Comparison with Native EventSource

| Capability | Native `EventSource` | Fetch Streamer |
|---|---|---|
| Custom headers | No | Yes |
| Bearer token auth | No | Yes |
| Share token auth | No | Yes |
| POST + body | No | Yes |
| Auto reconnect | Yes (built-in) | Yes |
| Exponential backoff | No (flat 3 s) | Yes |
| Backoff jitter | No | Yes |
| `Last-Event-ID` | Yes (auto) | Yes |
| `retry:` directive | Yes | Yes (clamped between `minRetryMs`/`maxRetryMs`) |
| Max retries limit | No | Yes (`maxRetries` option) |
| Token refresh hook | No | Yes (new instance in `onError`) |
| Typed error classes | No (generic Event) | Yes |
| Buffer size guard | No | Yes (`maxBufferLength`) |
| Connection timeout | No | Yes (`connectTimeoutMs`, retriable) |
| Heartbeat timeout | No | Yes (`heartbeatTimeoutMs`, retriable) |
| Teardown signal | `.close()` | `.close()` + `AbortSignal` |
| CR/CRLF line endings | Yes (browser) | Yes (manual) |
| Zero dependencies | Yes | Yes |
| Works in Web Workers | No | Yes |
| SSR / Node.js | No | Yes (requires `fetch` + `ReadableStream`) |

---

[← Integration Guide](./09-integration.md)
