# SSE Wire Format

Reference: https://html.spec.whatwg.org/multipage/server-sent-events.html

## Line Endings

The spec permits **three** line terminator forms. Implementations must handle all three:

| Terminator | Bytes |
|---|---|
| LF | `\n` (U+000A) |
| CR | `\r` (U+000D) |
| CRLF | `\r\n` |

An **event boundary** is a blank line — two consecutive terminators. The two terminators need not be the same form: mixed terminators both *within* an event block and *across* the boundary itself are allowed (e.g. an LF line-end followed by a CRLF blank line). A `\r\n` always counts as a single terminator, including when the `\r` ends one network chunk and the `\n` begins the next. See [Parser Compliance §7.1](./07-parser.md#71-line-ending-support).

## Field Format

```
field: value\n
```

Rules (from spec):
- If a line has **no colon**, the entire line is the field name and the value is the **empty string**.
- If a line starts with `:` it is a **comment** — ignore entirely.
- If the value begins with exactly **one U+0020 SPACE**, strip it. Additional leading spaces are preserved.

## Fields

| Field | Description |
|---|---|
| `event:` | Event type name. Defaults to `"message"`. |
| `data:` | Event data. Multiple `data:` lines are joined with `"\n"`. |
| `id:` | Event ID. Stored as `lastEventId`, sent as `Last-Event-ID` header on reconnect. Ignored if value contains `\0` (NULL). Empty value is valid and resets `lastEventId`. |
| `retry:` | Reconnect interval override in ms. Value must be **all ASCII digits**; otherwise ignored. |

## Dispatch Rules

An event is dispatched when a blank line is encountered **and** the data buffer is non-empty. An event block containing only `event:` or `id:` fields with no `data:` field is silently dropped.

## Example

```
event: device.update\n
data: {"id":1,"status":"online"}\n
id: 42\n
retry: 3000\n
\n
```

```
: this is a comment — ignored\n
\n
data: first line\n
data: second line\n
\n
```
→ dispatches `{ type: "message", data: "first line\nsecond line", lastEventId: "" }`

---

[← Background](./01-background.md) | [Next: Architecture →](./03-architecture.md)
