# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - Unreleased

### Fixed

- The published package can now be imported by plain Node ESM: relative imports in the
  built output carry `.js` extensions, and `exports` lists `types` first.
- An event whose `data` field is empty (`data:`) is now dispatched with `data: ''`, as
  the WHATWG spec and native `EventSource` do. Consumers will start receiving events
  such as empty-payload heartbeats and sentinels that were previously dropped.
- `maxBufferLength` now bounds the pending event, so many `data:` lines without a blank
  line can no longer grow without limit, and many small events in a single chunk no
  longer trigger a false `FetchStreamerBufferError`.
- No events are delivered after `close()`, including the remainder of the chunk being
  processed when `onMessage` calls it.
- `close()` (or aborting the external signal) while a stream was open no longer raises an
  unhandled `AbortError`, which terminated Node.js processes that had no
  `connectTimeoutMs` set.
- Connections no longer pile up: the request is aborted whenever a connection attempt
  ends (error status, wrong content type, throwing `onOpen`), and `close()` now reaches
  the request for its whole lifetime when `connectTimeoutMs` is set.
- `Last-Event-ID` is sent as UTF-8 bytes, as native `EventSource` does. An id outside
  Latin-1 previously made every reconnect fail; an id containing control characters is
  now omitted.
- A large event split across many network chunks is parsed in linear time.
- Calling `close()` from `onError` no longer leaves a backoff timer running.
- `Content-Type` is matched case-insensitively.
- A rejecting async `onMessage` is reported to `onError`; rejections from async
  `onError` and `onClose` are swallowed, like their synchronous exceptions. After the
  caller's `close()` it is not reported. If the stream ended by itself it is, which
  means `onError` can follow `onClose`.
- `Infinity` or `NaN` as `connectTimeoutMs`/`heartbeatTimeoutMs` means no timeout
  instead of firing immediately, and oversized retry delays no longer overflow timers.
- HTTP 204 stops reconnection (reported as `FetchStreamerHttpError` with status 204)
  instead of being retried forever.
- `id:` in a block without `data:` now updates `Last-Event-ID`, and an empty `event:`
  name dispatches as `message`, as native `EventSource` does.

## [0.2.0] - 2026-06-13

### Added

- `headers` now accepts a `HeaderProvider` function (sync or async) in addition to a
  static object. The provider is re-invoked on **every** connection attempt, so a
  reconnect can attach a freshly-minted credential (e.g. a refreshed auth token)
  instead of reusing the one captured at construction. A provider throw/rejection is
  treated as a retriable connection failure.
- Exported the `HeaderProvider` type.

### Changed

- Header resolution runs under the connection's abort signal. `close()` and
  `connectTimeoutMs` now interrupt a header provider that hangs, so a connection
  attempt never blocks indefinitely on credential acquisition. A provider that
  settles after an abort is ignored — no stray request is fired and `onClose` stays
  single-fire.

## [0.1.0] - 2026-05-24

Initial release.

### Added

- `FetchStreamer` — SSE client over `fetch` + `ReadableStream` with custom request
  headers (Bearer tokens, API keys, share tokens) on every request, including reconnects.
- Spec-compliant, line-oriented SSE parser: CR / LF / CRLF and mixed-style boundaries,
  CRLF split across chunks, correct `id:` empty-value semantics, and strict `retry:`
  digit validation.
- Automatic reconnect with exponential backoff, ±25% jitter, and a `minRetryMs` floor.
- Server-sent `retry:` values clamped between `minRetryMs` and `maxRetryMs`.
- `maxRetries` cap and `reconnectOnError` toggle; non-retriable HTTP statuses
  (401, 403, 404, 405, 410, 422) never retried.
- `connectTimeoutMs` and `heartbeatTimeoutMs` — both retriable.
- Typed error classes: `FetchStreamerHttpError`, `FetchStreamerContentTypeError`,
  `FetchStreamerBufferError`, `FetchStreamerConnectTimeoutError`,
  `FetchStreamerHeartbeatError`.
- `AbortSignal` support (incl. pre-aborted signals) and an idempotent `close()`.
- POST support with a static body, `withCredentials`, and `Last-Event-ID` resumption.
- Bounded SSE buffer (`maxBufferLength`) as an OOM guard.
- Handler isolation: a throwing `onMessage` is routed to `onError` and never tears
  down the connection.
- Zero runtime dependencies. ESM-only, ships TypeScript types. Works in browsers,
  Node.js 18+, and Web Workers.
