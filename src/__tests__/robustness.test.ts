import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { FetchStreamer } from '../FetchStreamer.js';
import { createSSEParser, type ParsedEvent } from '../parser.js';
import { FetchStreamerBufferError } from '../errors.js';
import { MockSSEStream, makeSSEResponse, makeErrorResponse } from './helpers/MockSSEStream.js';

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

function collect(maxBufferLength: number) {
  const events: ParsedEvent[] = [];
  const push = createSSEParser((e) => events.push({ ...e }), maxBufferLength);
  return { events, push };
}

describe('maxBufferLength counts event data, not wire syntax', () => {
  it.each(['data: ', 'data:'])('allows data of exactly the limit after "%s"', (prefix) => {
    const { events, push } = collect(20);
    push(`${prefix}${'x'.repeat(20)}\n\n`);
    expect(events[0].data).toHaveLength(20);
  });

  it('allows the same when the line arrives byte by byte', () => {
    const { events, push } = collect(20);
    for (const ch of `data: ${'x'.repeat(20)}\n\n`) push(ch);
    expect(events[0].data).toHaveLength(20);
  });

  it('still rejects one character over, terminated or not', () => {
    expect(() => collect(20).push(`data: ${'x'.repeat(21)}\n`)).toThrow(FetchStreamerBufferError);
    expect(() => collect(20).push(`data: ${'x'.repeat(21)}`)).toThrow(FetchStreamerBufferError);
  });

  it('does not add a keepalive comment to the pending data', () => {
    const { events, push } = collect(20);
    push(`data: ${'x'.repeat(18)}\n: keepalive\n\n`);
    expect(events).toHaveLength(1);
  });

  it('still bounds a single endless comment or unknown line', () => {
    expect(() => collect(20).push(`:${'x'.repeat(30)}`)).toThrow(FetchStreamerBufferError);
  });

  it('treats NaN as no limit, as before 0.2.1', () => {
    const { events, push } = collect(Number.NaN);
    push('data: a\n\n');
    expect(events).toHaveLength(1);
  });
});

describe('FetchStreamer option and callback handling', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function serve(response: () => Response) {
    const fetchFn = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchFn);
    return fetchFn;
  }

  it('starts no backoff timer when onError calls close()', async () => {
    vi.useFakeTimers();
    serve(() => makeErrorResponse(500));
    const s: FetchStreamer = new FetchStreamer('/e', { onError: () => s.close() });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts the content type in any letter case', async () => {
    const stream = new MockSSEStream();
    serve(() => makeSSEResponse(stream, { contentType: 'Text/Event-Stream; charset=utf-8' }));
    const onOpen = vi.fn();
    const s = new FetchStreamer('/e', { onOpen });
    await wait();
    expect(onOpen).toHaveBeenCalled();
    s.close();
  });

  it('routes a rejecting async onMessage to onError', async () => {
    const stream = new MockSSEStream();
    serve(() => makeSSEResponse(stream));
    const onError = vi.fn();
    const failure = new Error('handler');
    const s = new FetchStreamer('/e', { onMessage: async () => { throw failure; }, onError });
    await wait();
    stream.push('data: a\n\n');
    await wait(10);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(unhandled).toEqual([]);
    s.close();
  });

  it('swallows rejecting async onError and onClose', async () => {
    serve(() => makeErrorResponse(404));
    new FetchStreamer('/e', {
      onError: async () => { throw new Error('a'); },
      onClose: async () => { throw new Error('b'); },
    });
    await wait(10);
    expect(unhandled).toEqual([]);
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN])('treats a %s timeout as no timeout', async (value) => {
    const stream = new MockSSEStream();
    serve(() => makeSSEResponse(stream));
    const onError = vi.fn();
    const s = new FetchStreamer('/e', { connectTimeoutMs: value, heartbeatTimeoutMs: value, onError });
    await wait(30);
    expect(onError).not.toHaveBeenCalled();
    s.close();
  });

  it('does not turn an oversized retry delay into a tight loop', async () => {
    const fetchFn = serve(() => makeErrorResponse(500));
    const s = new FetchStreamer('/e', { initialRetryMs: Number.POSITIVE_INFINITY, maxRetryMs: Number.POSITIVE_INFINITY });
    await wait(30);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    s.close();
  });
});
