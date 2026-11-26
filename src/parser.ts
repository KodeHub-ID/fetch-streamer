import { FetchStreamerBufferError } from './errors.js';

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
  /** Called for a terminated block that carried `id:` but dispatched no event. */
  onIdWithoutEvent?: (id: string) => void,
) {
  // Pieces of the unterminated trailing line, waiting for the rest of it. Kept as
  // pieces and joined once, so a long line split over many chunks costs linear time.
  let pending: string[] = [];
  let pendingLength = 0;
  // First characters of the unterminated line, enough to recognise a `data:` field.
  let pendingHead = '';
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

  function discardPending(): void {
    pending = [];
    pendingLength = 0;
    pendingHead = '';
  }

  // Bounds memory held for the pending event. For a `data` line that is the data
  // accumulated so far (with its LF separators) plus this line's value; the field
  // name is wire syntax and does not count. Any other line is not accumulated, so
  // it is bounded on its own. Completed events never count, so many small events in
  // one network chunk are fine.
  function assertWithinLimit(head: string, lineLength: number, terminated: boolean): void {
    let size = lineLength;
    // A bare "data" is that field only once the line ends; until then it may turn
    // out to be the start of a longer name such as "datax".
    if (head.startsWith('data:') || (terminated && head === 'data')) {
      const prefix = head.startsWith('data: ') ? 6 : 5;
      size = Math.max(0, lineLength - prefix) + (dataSeen ? data.length + 1 : 0);
    }
    // Written as a negation so a NaN limit means "no limit".
    if (!(size > maxBufferLength)) return;

    discardPending();
    sawCR = false;
    resetEvent();
    throw new FetchStreamerBufferError(maxBufferLength);
  }

  function processLine(line: string): void {
    // Blank line: dispatch the accumulated event, then reset for the next one.
    if (line === '') {
      // Spec: the emptiness check runs while each data line still carries its LF,
      // so a single `data:` with no value IS dispatched (with data ''). Only a
      // block with no data field at all is dropped.
      // id is passed as-is (undefined = field absent, '' = explicit reset).
      if (dataSeen) {
        // An empty `event:` name means the default type.
        onEvent({ type: eventType || 'message', data, id, retry });
      } else if (id !== undefined) {
        // The spec commits the id at every blank line, event or not.
        onIdWithoutEvent?.(id);
      }
      resetEvent();
      return;
    }

    assertWithinLimit(line.slice(0, 6), line.length, true);

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

    const len = chunk.length;
    let start = 0;

    for (let i = 0; i < len; i++) {
      const ch = chunk[i];
      if (ch !== '\n' && ch !== '\r') continue;

      let line = chunk.slice(start, i);
      if (pendingLength > 0) {
        line = pending.join('') + line;
        discardPending();
      }
      processLine(line);

      if (ch === '\r') {
        // Trailing CR: the line is complete, but a `\n` may still arrive next chunk
        // to form a CRLF. Emit the line now and defer the CRLF decision.
        if (i === len - 1) sawCR = true;
        else if (chunk[i + 1] === '\n') i++;
      }
      start = i + 1;
    }

    // Keep only the unterminated remainder for the next chunk.
    if (start < len) {
      if (pendingHead.length < 6) {
        pendingHead = (pendingHead + chunk.slice(start, start + 6)).slice(0, 6);
      }
      pending.push(chunk.slice(start));
      pendingLength += len - start;
      // A line with no terminator yet must be bounded too.
      assertWithinLimit(pendingHead, pendingLength, false);
    }
  };
}
