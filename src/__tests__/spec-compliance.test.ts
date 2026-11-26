import { afterEach, describe, it, expect, vi } from 'vitest';
import { FetchStreamer } from '../FetchStreamer.js';
import { createSSEParser, type ParsedEvent } from '../parser.js';
import { FetchStreamerBufferError } from '../errors.js';
import { MockSSEStream, makeSSEResponse } from './helpers/MockSSEStream.js';

function collect(maxBufferLength = 1_048_576) {
  const events: ParsedEvent[] = [];
  const push = createSSEParser((e) => events.push({ ...e }), maxBufferLength);
  return { events, push };
}

// Expected values are what the browser's native EventSource delivers for the same bytes.
describe('empty data dispatches (WHATWG: the LF appended per data line makes the buffer non-empty)', () => {
  it.each([
    ['data: with no value', 'event:x\ndata:\n\n'],
    ['data: with only the optional space', 'event: x\ndata: \n\n'],
    ['data without a colon', 'event: x\ndata\n\n'],
  ])('%s', (_name, wire) => {
    const { events, push } = collect();
    push(wire);
    expect(events).toMatchObject([{ type: 'x', data: '' }]);
  });

  it('still drops a block with no data line at all', () => {
    const { events, push } = collect();
    push('event: x\n\n');
    expect(events).toHaveLength(0);
  });
});

describe('maxBufferLength bounds the pending event, not the network chunk', () => {
  it('delivers many small complete events arriving in one chunk', () => {
    const { events, push } = collect(100);
    push('data: a\n\n'.repeat(20));
    expect(events).toHaveLength(20);
  });

  it('throws when data lines accumulate past the limit without a blank line', () => {
    const { events, push } = collect(100);
    expect(() => {
      for (let i = 0; i < 50; i++) push('data: 0123456789\n');
    }).toThrow(FetchStreamerBufferError);
    expect(events).toHaveLength(0);
  });

  it('counts empty data lines too', () => {
    const { push } = collect(100);
    expect(() => push('data:\n'.repeat(200))).toThrow(FetchStreamerBufferError);
  });

  it('counts an unterminated line on top of the accumulated data', () => {
    const { push } = collect(30);
    push('data: 01234567890123456789\n');
    expect(() => push('data: 0123456789')).toThrow(FetchStreamerBufferError);
  });

  it('discards the oversized event so the parser can be reused', () => {
    const { events, push } = collect(40);
    expect(() => push('data: 0123456789\n'.repeat(10))).toThrow(FetchStreamerBufferError);
    push('data: ok\n\n');
    expect(events).toMatchObject([{ data: 'ok' }]);
  });
});

describe('no events after close()', () => {
  afterEach(() => vi.unstubAllGlobals());
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it('stops delivering the rest of a chunk once onMessage calls close()', async () => {
    const stream = new MockSSEStream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSSEResponse(stream)));
    const got: string[] = [];
    const s: FetchStreamer = new FetchStreamer('/events', {
      onMessage: (e) => {
        got.push(e.data);
        s.close();
      },
    });
    await tick();
    stream.push('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    await tick();
    expect(got).toEqual(['1']);
  });
});

describe('large events split into many chunks', () => {
  it('parses a 1 MB line arriving in 512-byte chunks in linear time', () => {
    const { events, push } = collect(2_000_000);
    const wire = `data: ${'x'.repeat(1_000_000)}\n\n`;
    const started = performance.now();
    for (let i = 0; i < wire.length; i += 512) push(wire.slice(i, i + 512));
    expect(events[0].data).toHaveLength(1_000_000);
    // Linear parsing takes a few ms; the quadratic version took seconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps CR/LF handling across every split point', () => {
    const wire = 'event: a\r\ndata: 1\rdata: 2\n\r\ndata: 3\r\r';
    for (let cut = 0; cut <= wire.length; cut++) {
      for (let cut2 = cut; cut2 <= wire.length; cut2++) {
        const { events, push } = collect();
        [wire.slice(0, cut), wire.slice(cut, cut2), wire.slice(cut2)].forEach(push);
        expect(events.map((e) => `${e.type}:${e.data}`)).toEqual(['a:1\n2', 'message:3']);
      }
    }
  });
});
