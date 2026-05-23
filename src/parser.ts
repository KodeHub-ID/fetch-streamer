import { FetchStreamerBufferError } from './errors';

export interface ParsedEvent {
  type: string;
  data: string;
  /**
   * `undefined`  — no `id:` field was present in this event block.
   * `''`         — `id:` was present with an empty value (spec: resets lastEventId).
   * `'<value>'`  — `id:` was present with a non-empty value.
   */
  id: string | undefined;
  retry?: number;
}

/**
 * Creates a streaming, spec-compliant SSE parser.
 *
 * The returned `push` function accepts raw text chunks (partial or complete).
 * It splits the stream into lines, accumulates fields, and calls `onEvent` for
 * each event terminated by a blank line.
 *
 * The parser is a line-oriented state machine rather than a boundary-regex
 * splitter. This is what makes it fully WHATWG-compliant:
 *
 *   - A line terminator is CR, LF, or CRLF. `\r\n` is always treated as a single
 *     terminator (never as CR followed by an empty-line LF), including when the
 *     `\r` ends one chunk and the `\n` begins the next (`sawCR` carries the state).
 *   - A blank line dispatches the pending event regardless of which terminator
 *     style surrounds it, so mixed-style boundaries (e.g. `\n\r\n`) are handled.
 *   - Event accumulator state persists across chunks until a blank line, so a
 *     single event split over many `push()` calls is assembled correctly.
 *
 * @param maxBufferLength - Limit in UTF-16 code units (JS string `.length`). For
 *   ASCII-only streams this equals bytes. For multi-byte Unicode (CJK = 3 bytes /
 *   1 code unit; emoji = 4 bytes / 2 code units), the wire-byte limit is higher
 *   than this number — see `maxBufferLength` option docs for the full breakdown.
 *
 * Compliant with the WHATWG event-stream parsing algorithm:
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 */
export function createSSEParser(
  onEvent: (event: ParsedEvent) => void,
  maxBufferLength: number,
) {
  // Unterminated trailing text waiting for the rest of its line.
  let buffer = '';
  // True when the previous chunk ended with a lone `\r`; a `\n` opening the next
  // chunk is the tail of that CRLF and must be swallowed, not treated as a line.
  let sawCR = false;

  // Per-event accumulators. Persist across lines AND chunks until a blank line
  // dispatches the event and resets them.
  let eventType = 'message';
  let data = '';
  let dataSeen = false;
  let id: string | undefined;
  let retry: number | undefined;

  function resetEvent(): void {
    eventType = 'message';
    data = '';
    dataSeen = false;
    id = undefined;
    retry = undefined;
  }

  function processLine(line: string): void {
    // Blank line: dispatch the accumulated event, then reset for the next one.
    if (line === '') {
      // Spec: dispatch only when the data buffer is non-empty.
      // id is passed as-is (undefined = field absent, '' = explicit reset).
      if (dataSeen && data !== '') {
        onEvent({ type: eventType, data, id, retry });
      }
      resetEvent();
      return;
    }

    if (line[0] === ':') return; // comment — spec says ignore

    const colonIdx = line.indexOf(':');

    // Spec: a line with no colon means field = entire line, value = "".
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);

    // Spec: if value begins with exactly one U+0020 SPACE, strip it.
    const value =
      colonIdx === -1 ? '' : line.slice(colonIdx + 1).replace(/^ /, '');

    switch (field) {
      case 'event':
        eventType = value;
        break;

      case 'data':
        // Spec appends value + LF for each data line; trailing LF removed at dispatch.
        // Equivalent: join multiple data lines with "\n".
        data = dataSeen ? `${data}\n${value}` : value;
        dataSeen = true;
        break;

      case 'id':
        // Spec: ignore if value contains U+0000 NULL; otherwise always update
        // (empty value is valid and signals a lastEventId reset).
        if (!value.includes('\0')) id = value;
        break;

      case 'retry':
        // Spec: field value must consist entirely of ASCII digits.
        if (/^\d+$/.test(value)) {
          retry = parseInt(value, 10);
        }
        break;
    }
  }

  return function push(chunk: string): void {
    if (chunk === '') return;

    // Reattach a CRLF split across the chunk boundary: a leading `\n` here is the
    // tail of a `\r` that ended the previous chunk, so drop it (the line was
    // already emitted when that `\r` was processed).
    if (sawCR) {
      if (chunk[0] === '\n') chunk = chunk.slice(1);
      sawCR = false;
    }

    buffer += chunk;

    if (buffer.length > maxBufferLength) {
      buffer = '';
      resetEvent();
      throw new FetchStreamerBufferError(maxBufferLength);
    }

    const len = buffer.length;
    let start = 0;
    let i = 0;

    while (i < len) {
      const ch = buffer[i];

      if (ch === '\n') {
        processLine(buffer.slice(start, i));
        i += 1;
        start = i;
      } else if (ch === '\r') {
        if (i === len - 1) {
          // Trailing CR: the line is complete, but a `\n` may still arrive next
          // chunk to form a CRLF. Emit the line now and defer the CRLF decision.
          processLine(buffer.slice(start, i));
          sawCR = true;
          i += 1;
          start = i;
        } else {
          processLine(buffer.slice(start, i));
          i += buffer[i + 1] === '\n' ? 2 : 1;
          start = i;
        }
      } else {
        i += 1;
      }
    }

    // Keep only the unterminated remainder for the next chunk.
    buffer = start === 0 ? buffer : buffer.slice(start);
  };
}
