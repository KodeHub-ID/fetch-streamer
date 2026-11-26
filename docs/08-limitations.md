# Known Limitations

## 8.1 No Page Visibility Handling

Native browsers throttle timers in inactive tabs. A reconnect backoff of 30 s may be skewed. On mobile, the browser may suspend fetch streams when the page is backgrounded.

This is intentional: embedding `document.addEventListener('visibilitychange', ...)` would bind the library to the browser `document` global, breaking Node.js, Web Workers, and SSR environments. The library is kept universal.

**Caller-side workaround (browser only):**

```ts
const stream = new FetchStreamer(url, options);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    stream.close();
    stream = new FetchStreamer(url, options); // fresh instance on tab focus
  }
});
```

## 8.2 No Online/Offline Detection

If `navigator.onLine` is `false`, reconnect attempts will fail immediately and retry with backoff, which is correct but wasteful.

Like 8.1, embedding `navigator` or `window.addEventListener('online', ...)` would break the universal runtime guarantee.

**Caller-side workaround (browser only):**

```ts
const stream = new FetchStreamer(url, options);

window.addEventListener('online', () => {
  stream.close();
  stream = new FetchStreamer(url, options); // reconnect immediately on network restore
});
```

## 8.3 POST Body is Static

The `body` option is a static string set at construction. There is no hook to re-compute the body on reconnect.

This is a deliberate design boundary: SSE streams are almost always `GET` requests. A `POST` body that changes between reconnects means the request semantics changed — that is a new logical stream, not a reconnect of the same one. Create a new instance instead:

```ts
function connect(body: string) {
  return new FetchStreamer(url, { method: 'POST', body, ...options });
}

let stream = connect(buildBody());

// When the body needs to change:
stream.close();
stream = connect(buildBody());
```

## 8.4 A Silently Dead Connection Is Not Detected by Default

If the network path disappears without closing the connection (cable pulled, NAT or proxy state dropped), no bytes and no error reach the client, and the read simply waits. Only a timeout can detect this, and `heartbeatTimeoutMs` has no default: a server that legitimately stays quiet would otherwise be disconnected over and over.

**What to do:** send a comment or event at a fixed interval and set `heartbeatTimeoutMs` to about twice that interval.

```ts
// Server writes ": ping" every 30 s
new FetchStreamer(url, { heartbeatTimeoutMs: 60_000 });
```

## 8.5 A Close-Delimited Response Cannot Be Told Apart From a Clean End

When a response has neither `Content-Length` nor chunked encoding (HTTP/1.0 style, `Connection: close`), the end of the connection *is* the end of the response. A stream cut off part-way is then indistinguishable from one the server finished, so `onClose` fires and nothing is retried. What a TCP reset does in this case varies between runtimes: Chromium-based browsers report an error, Node.js 22 reports a clean end.

With chunked encoding, a cut before the terminating chunk is reported as an error and retried.

**What to do:** serve streams with HTTP/1.1 chunked encoding or HTTP/2, and check that reverse proxies preserve it. Where the client must know the server ended the stream on purpose, send a final event before closing.

---

[← Parser Compliance](./07-parser.md) | [Next: Integration Guide →](./09-integration.md)
