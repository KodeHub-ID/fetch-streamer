# Background & Motivation

Native `EventSource` is a convenience API over a long-lived HTTP response. Browsers parse the `text/event-stream` format and expose events via `onmessage`. The problem: browsers **prohibit setting custom headers** on `EventSource` requests. The only authentication mechanism it supports is cookies via `withCredentials: true`.

This makes it unusable for any project that authenticates with:
- Bearer tokens (Firebase Auth, JWT)
- API keys in request headers
- Share tokens (`X-Share-Token`, etc.)

Fetch Streamer provides the same kind of stream using `fetch` + `ReadableStream`. The `fetch` API has no header restrictions. We read the response body as a byte stream, decode it incrementally, and parse the SSE format manually. Parsing follows the specification; reconnection deliberately differs — see [Comparison](./10-comparison.md).

Compared to native `EventSource`:
- Custom headers on every request, including reconnects
- Exponential backoff with jitter
- No automatic reconnect once the server completes the response
- Typed error classes (vs. generic `Event`)
- `maxRetries` option and security guards against malicious server hints

---

[← Back to README](../README.md) | [Next: SSE Wire Format →](./02-sse-format.md)
