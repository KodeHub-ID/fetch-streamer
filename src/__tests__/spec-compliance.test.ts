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
