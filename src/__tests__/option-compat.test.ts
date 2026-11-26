// Options from untyped callers (plain JavaScript, JSON or env config) must keep
// behaving as they did in 0.2.0.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { FetchStreamer } from '../FetchStreamer.js';
import { createSSEParser } from '../parser.js';
import { FetchStreamerConnectTimeoutError, FetchStreamerHeartbeatError } from '../errors.js';
import type { FetchStreamerOptions } from '../types.js';
import { MockSSEStream, makeSSEResponse, makeErrorResponse } from './helpers/MockSSEStream.js';

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
// Deliberately outside the declared types, as a JavaScript caller can be.
const untyped = (options: Record<string, unknown>) => options as FetchStreamerOptions;

afterEach(() => vi.unstubAllGlobals());

describe('null and string option values', () => {
  // The other two values are small, so a null read as 0 shows up as a burst of requests.
  it.each([
    ['initialRetryMs', { initialRetryMs: null, minRetryMs: 1, maxRetryMs: 5000 }, 1],
    ['maxRetryMs', { initialRetryMs: 10, minRetryMs: 1, maxRetryMs: null }, 8],
    ['minRetryMs', { initialRetryMs: 1, minRetryMs: null, maxRetryMs: 1 }, 1],
  ])('treats a null %s as the default, not as zero', async (_name, options, atMost) => {
    const fetchFn = vi.fn(async () => makeErrorResponse(500));
    vi.stubGlobal('fetch', fetchFn);
    const s = new FetchStreamer('/e', untyped(options));
    await wait(100);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(atMost);
    s.close();
  });

  it('honours a numeric string connectTimeoutMs', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    const onError = vi.fn();
    const s = new FetchStreamer('/e', untyped({ connectTimeoutMs: '30', onError }));
    await wait(80);
    expect(onError).toHaveBeenCalledWith(expect.any(FetchStreamerConnectTimeoutError));
    s.close();
  });

  it('honours a numeric string heartbeatTimeoutMs', async () => {
    vi.stubGlobal('fetch', async () => makeSSEResponse(new MockSSEStream()));
    const onError = vi.fn();
    const s = new FetchStreamer('/e', untyped({ heartbeatTimeoutMs: '30', onError }));
    await wait(80);
    expect(onError).toHaveBeenCalledWith(expect.any(FetchStreamerHeartbeatError));
    s.close();
  });

  it.each([null, ''])('treats a %j timeout as no timeout', async (value) => {
    vi.stubGlobal('fetch', async () => makeSSEResponse(new MockSSEStream()));
    const onError = vi.fn();
    const s = new FetchStreamer(
      '/e',
      untyped({ connectTimeoutMs: value, heartbeatTimeoutMs: value, onError }),
    );
    await wait(30);
    expect(onError).not.toHaveBeenCalled();
    s.close();
  });
});

describe('a rejecting async onMessage around close', () => {
  async function run(end: (stream: MockSSEStream, s: FetchStreamer) => void) {
    const stream = new MockSSEStream();
    vi.stubGlobal('fetch', async () => makeSSEResponse(stream));
    const calls: string[] = [];
    const s = new FetchStreamer('/e', {
      onMessage: async () => {
        await wait(20);
        throw new Error('late');
      },
      onError: () => calls.push('onError'),
      onClose: () => calls.push('onClose'),
    });
    await wait();
    stream.push('data: a\n\n');
    await wait();
    end(stream, s);
    await wait(50);
    return calls;
  }

  it('does not call onError after the caller closed the stream', async () => {
    expect(await run((_stream, s) => s.close())).toEqual(['onClose']);
  });

  it('still reports it when the server ended the stream', async () => {
    expect(await run((stream) => stream.close())).toEqual(['onClose', 'onError']);
  });
});

describe('buffer limit does not depend on where chunks split', () => {
  it('judges a field that merely starts with "data" on its own length', () => {
    const wire = 'data: 0123456789\ndatax\n\n';
    for (let cut = 0; cut <= wire.length; cut++) {
      const push = createSSEParser(() => {}, 10);
      expect(() => {
        push(wire.slice(0, cut));
        push(wire.slice(cut));
      }, `split at ${cut}`).not.toThrow();
    }
  });
});
