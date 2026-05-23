# Parser: Compliance Notes

The parser is a **line-oriented state machine**, not a boundary-regex splitter. It scans each chunk for line terminators, accumulates fields, and dispatches the pending event when it reaches a blank line. Event-accumulator state (`event`, `data`, `id`, `retry`) persists across both lines and `push()` calls until a blank line dispatches and resets it.

## 7.1 Line Ending Support

A line terminator is CR, LF, or CRLF. The scanner treats them as follows:

- `\n` ends the current line.
- `\r` ends the current line and consumes a following `\n` as part of the same CRLF.
- A `\r` at the very end of a chunk is held (`sawCR`): if the next chunk begins with `\n`, that `\n` is the tail of the CRLF and is dropped — so a CRLF split across a chunk boundary is never mistaken for an empty line.

A **blank line** (an empty line between any two terminators) dispatches the event, so **mixed-style boundaries are handled** — e.g. an LF line-end followed by a CRLF blank line (`...\n\r\n`), or any other CR/LF/CRLF combination. The earlier regex-splitter only recognised the three *pure* boundary forms (`\n\n`, `\r\r`, `\r\n\r\n`); the state machine recognises all of them.

## 7.2 Field With No Colon

Per spec, a line with no `:` character means the field name is the entire line and the value is the empty string. Such lines are handled correctly:

```ts
const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
const value = colonIdx === -1 ? '' : line.slice(colonIdx + 1).replace(/^ /, '');
```

## 7.3 `retry:` Validation

The spec requires the value to consist **entirely of ASCII digits**. A regex validates this invariant before parsing, since `parseInt` accepts mixed input — `parseInt('5abc', 10)` returns `5`:

```ts
if (/^\d+$/.test(value)) retry = parseInt(value, 10);
```

## 7.4 `id:` NULL Guard and Empty Value Semantics

If the `id:` value contains U+0000 (NULL), the field is ignored.

An `id:` field with an **empty value** is valid and acts as a reset signal — subsequent reconnects will not send a `Last-Event-ID` header. `ParsedEvent.id` is typed as `string | undefined` to distinguish three states:

| Value | Meaning |
|---|---|
| `undefined` | No `id:` field in this block — `lastEventId` unchanged |
| `''` | `id:` present with empty value — `lastEventId` reset to `''` |
| `'<value>'` | `id:` present — `lastEventId` updated |

The consumer checks `if (parsed.id !== undefined)` rather than a truthy check so the empty-value reset is not silently dropped.

## 7.5 `data:` Empty String Dispatch

A `data:` field with an empty value still sets the `dataSeen` flag. A single such field results in a data buffer of `""`, and since the buffer is empty, no event is dispatched. But `data:` followed by `data: hello` correctly produces `"\nhello"` because `dataSeen` is already `true` by the second field.

## 7.6 Buffer Bound Discards the In-Flight Event

The text buffer holds only the *unterminated trailing line*; completed lines are consumed as they are scanned. If that buffer grows past `maxBufferLength` (a server streaming a line with no terminator), the buffer **and** the partially-accumulated event state are discarded and `FetchStreamerBufferError` is thrown. Resetting the event state prevents a half-read event from leaking into the next connection's first dispatch. See [Security §5.2](./05-security.md#52-sse-buffer-is-bounded).

---

[← Implementation Decisions](./06-implementation.md) | [Next: Known Limitations →](./08-limitations.md)
