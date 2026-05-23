import { describe, it, expect } from 'vitest';
import { createSSEParser, type ParsedEvent } from '../parser';
import { FetchStreamerBufferError } from '../errors';

// Convenience: feed chunks through the parser and collect all dispatched events.
function parse(chunks: string[], maxBufferLength = 1_048_576): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const push = createSSEParser((e) => events.push({ ...e }), maxBufferLength);
  for (const chunk of chunks) push(chunk);
  return events;
}

// Single-chunk shorthand.
function parseOne(text: string): ParsedEvent[] {
  return parse([text]);
}

describe('SSE parser', () => {
  describe('basic dispatch', () => {
    it('dispatches a simple data event', () => {
      const events = parseOne('data: hello\n\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'message', data: 'hello' });
    });

    it('defaults event type to "message"', () => {
      expect(parseOne('data: x\n\n')[0].type).toBe('message');
    });

    it('sets event type from event: field', () => {
      const events = parseOne('event: device.update\ndata: x\n\n');
      expect(events[0].type).toBe('device.update');
    });

    it('dispatches nothing when data buffer is empty (no data field)', () => {
      expect(parseOne('event: ping\nid: 1\n\n')).toHaveLength(0);
    });

    it('dispatches nothing for a comment-only block', () => {
      expect(parseOne(': this is a comment\n\n')).toHaveLength(0);
    });

    it('dispatches nothing for an empty block', () => {
      expect(parseOne('\n\n')).toHaveLength(0);
    });
  });

  describe('line endings', () => {
    it('handles LF-terminated events', () => {
      expect(parseOne('data: lf\n\n')).toHaveLength(1);
    });

    it('handles CR-terminated events', () => {
      expect(parseOne('data: cr\r\r')).toHaveLength(1);
    });

    it('handles CRLF-terminated events', () => {
      expect(parseOne('data: crlf\r\n\r\n')).toHaveLength(1);
    });

    it('handles mixed line endings within a single event', () => {
      // CR line ending for event:, LF boundary
      const events = parseOne('event: mix\rdata: val\n\n');
      expect(events[0]).toMatchObject({ type: 'mix', data: 'val' });
    });

    it('handles multiple events with different line endings', () => {
      const events = parse(['data: a\r\rdata: b\n\ndata: c\r\n\r\n']);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.data)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('data field', () => {
    it('joins multiple data lines with \\n', () => {
      const events = parseOne('data: first\ndata: second\n\n');
      expect(events[0].data).toBe('first\nsecond');
    });

    it('empty data: followed by data: value produces \\nvalue', () => {
      const events = parseOne('data:\ndata: hello\n\n');
      expect(events[0].data).toBe('\nhello');
    });

    it('single empty data: field does not dispatch (data buffer is empty string)', () => {
      expect(parseOne('data:\n\n')).toHaveLength(0);
    });

    it('strips exactly one leading space from value', () => {
      expect(parseOne('data: hello\n\n')[0].data).toBe('hello');
    });

    it('strips only one space — additional leading spaces are preserved', () => {
      expect(parseOne('data:  indented\n\n')[0].data).toBe(' indented');
    });

    it('no space to strip when value follows colon directly', () => {
      expect(parseOne('data:nospace\n\n')[0].data).toBe('nospace');
    });
  });

  describe('id field', () => {
    it('sets id from id: field', () => {
      expect(parseOne('id: 42\ndata: x\n\n')[0].id).toBe('42');
    });

    it('empty id: value sets id to empty string (lastEventId reset)', () => {
      expect(parseOne('id:\ndata: x\n\n')[0].id).toBe('');
    });

    it('id is undefined when no id: field is present', () => {
      expect(parseOne('data: x\n\n')[0].id).toBeUndefined();
    });

    it('ignores id: value that contains U+0000 NULL', () => {
      expect(parseOne('id: a\0b\ndata: x\n\n')[0].id).toBeUndefined();
    });

    it('NULL anywhere in the value causes the whole field to be ignored', () => {
      const events = parseOne('id: valid\ndata: first\n\nid: has\0null\ndata: second\n\n');
      expect(events[0].id).toBe('valid');
      expect(events[1].id).toBeUndefined();
    });
  });

  describe('retry field', () => {
    it('sets retry from an all-digit value', () => {
      expect(parseOne('retry: 3000\ndata: x\n\n')[0].retry).toBe(3000);
    });

    it('ignores retry when value contains non-digit characters', () => {
      expect(parseOne('retry: 5abc\ndata: x\n\n')[0].retry).toBeUndefined();
    });

    it('ignores retry when value is empty', () => {
      expect(parseOne('retry:\ndata: x\n\n')[0].retry).toBeUndefined();
    });

    it('ignores retry when value is a decimal (parseInt-pass but not all-digits)', () => {
      expect(parseOne('retry: 1.5\ndata: x\n\n')[0].retry).toBeUndefined();
    });

    it('ignores retry when value has a leading minus sign', () => {
      expect(parseOne('retry: -1000\ndata: x\n\n')[0].retry).toBeUndefined();
    });

    it('parses a large all-digit retry value', () => {
      expect(parseOne('retry: 86400000\ndata: x\n\n')[0].retry).toBe(86_400_000);
    });
  });

  describe('field with no colon', () => {
    it('treats the entire line as field name with empty string value', () => {
      // A bare "data" line without colon sets data to '' → dataSeen = true
      // followed by "data: hello" → data = '\nhello'
      const events = parseOne('data\ndata: hello\n\n');
      expect(events[0].data).toBe('\nhello');
    });

    it('unknown field with no colon is silently ignored', () => {
      const events = parseOne('unknown\ndata: x\n\n');
      expect(events[0].data).toBe('x');
    });
  });

  describe('comments', () => {
    it('lines starting with : are ignored', () => {
      const events = parseOne(': heartbeat\ndata: x\n\n');
      expect(events[0].data).toBe('x');
    });

    it('a block of only comments produces no event', () => {
      expect(parseOne(': ping\n: pong\n\n')).toHaveLength(0);
    });
  });

  describe('streaming across multiple chunks', () => {
    it('assembles an event split across two chunks', () => {
      const events = parse(['data: hel', 'lo\n\n']);
      expect(events[0].data).toBe('hello');
    });

    it('assembles an event split at the boundary', () => {
      const events = parse(['data: hello\n', '\n']);
      expect(events[0].data).toBe('hello');
    });

    it('handles multiple complete events in a single chunk', () => {
      const events = parseOne('data: a\n\ndata: b\n\ndata: c\n\n');
      expect(events.map((e) => e.data)).toEqual(['a', 'b', 'c']);
    });

    it('handles a partial event followed by a complete event in next chunk', () => {
      const events = parse(['data: first\n\ndata: sec', 'ond\n\n']);
      expect(events).toHaveLength(2);
      expect(events[0].data).toBe('first');
      expect(events[1].data).toBe('second');
    });

    it('accumulates state across chunks (id carries over)', () => {
      // id set in first chunk, data in second
      const events = parse(['id: 99\n', 'data: x\n\n']);
      expect(events[0].id).toBe('99');
    });

    it('reassembles a CRLF terminator split across chunks', () => {
      // The "\r" ends the first chunk; the "\n" opening the second is its tail,
      // not a blank line. The two data lines must join, not dispatch separately.
      const events = parse(['data: a\r', '\ndata: b\n\n']);
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe('a\nb');
    });

    it('treats a lone trailing CR followed by a non-LF char as a real terminator', () => {
      const events = parse(['data: a\r', 'data: b\n\n']);
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe('a\nb');
    });

    it('dispatches when a blank-line boundary is split across chunks (CR then CR)', () => {
      const events = parse(['data: a\r', '\r']);
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe('a');
    });
  });

  describe('mixed-style blank-line boundaries', () => {
    it('dispatches on an LF line-end followed by a CRLF blank line', () => {
      const events = parseOne('data: a\n\r\ndata: b\n\n');
      expect(events.map((e) => e.data)).toEqual(['a', 'b']);
    });

    it('dispatches on a CRLF line-end followed by an LF blank line', () => {
      const events = parseOne('data: a\r\n\ndata: b\n\n');
      expect(events.map((e) => e.data)).toEqual(['a', 'b']);
    });

    it('dispatches on an LF line-end followed by a CR blank line', () => {
      const events = parseOne('data: a\n\rdata: b\n\n');
      expect(events.map((e) => e.data)).toEqual(['a', 'b']);
    });
  });

  describe('buffer overflow', () => {
    it('throws FetchStreamerBufferError when buffer exceeds maxBufferLength', () => {
      const push = createSSEParser(() => {}, 10);
      expect(() => push('data: this is definitely longer than ten\n\n')).toThrow(
        FetchStreamerBufferError,
      );
    });

    it('includes the configured limit in the error', () => {
      const push = createSSEParser(() => {}, 5);
      try {
        push('123456');
      } catch (err) {
        expect((err as FetchStreamerBufferError).limitLength).toBe(5);
      }
    });

    it('clears the buffer on overflow so the parser can be reused', () => {
      const events: ParsedEvent[] = [];
      const push = createSSEParser((e) => events.push(e), 20);

      expect(() => push('data: this string is definitely over 20 chars\n\n')).toThrow();
      // After clearing, a short event within the limit should work.
      push('data: ok\n\n');
      expect(events[0].data).toBe('ok');
    });

    it('does not throw when buffer is exactly at the limit', () => {
      // maxBufferLength = 10, push exactly 10 chars without a boundary
      const push = createSSEParser(() => {}, 10);
      expect(() => push('data: hi\n\n')).not.toThrow(); // 10 chars exactly before boundary strip
    });
  });

  describe('full event with all fields', () => {
    it('dispatches a complete event with event, data, id, and retry', () => {
      const events = parseOne(
        'event: device.update\ndata: {"id":1}\nid: 42\nretry: 3000\n\n',
      );
      expect(events[0]).toEqual({
        type: 'device.update',
        data: '{"id":1}',
        id: '42',
        retry: 3000,
      });
    });
  });
});
