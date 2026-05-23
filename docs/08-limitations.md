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

---

[← Parser Compliance](./07-parser.md) | [Next: Integration Guide →](./09-integration.md)
