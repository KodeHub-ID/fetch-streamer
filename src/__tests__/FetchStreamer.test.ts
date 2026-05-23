import { afterEach, describe, it, expect, vi } from 'vitest';
import { FetchStreamer } from '../FetchStreamer';
import {
  FetchStreamerHttpError,
  FetchStreamerContentTypeError,
  FetchStreamerConnectTimeoutError,
  FetchStreamerHeartbeatError,
} from '../errors';
import { MockSSEStream, makeSSEResponse, makeErrorResponse } from './helpers/MockSSEStream';

// Macrotask boundary — drains the ReadableStream read loop under REAL timers.
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

function stubFetch() {
  const fn = vi.fn();
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A fetch that never resolves on its own but rejects (AbortError) when aborted. */
function hangUntilAbort(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('FetchStreamer — connection & messages', () => {
  it('calls onOpen once, then onMessage per dispatched event', async () => {
    const fetchFn = stubFetch();
    const stream = new MockSSEStream();
    fetchFn.mockResolvedValue(makeSSEResponse(stream));

    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const s = new FetchStreamer('/events', { onOpen, onMessage });

    await tick();
    expect(onOpen).toHaveBeenCalledTimes(1);

    stream.push('data: hello\n\n');
    await tick();
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', data: 'hello', lastEventId: '' }),
    );

    stream.push('event: ping\ndata: world\nid: 7\n\n');
    await tick();
    expect(onMessage).toHaveBeenLastCalledWith({
      type: 'ping',
      data: 'world',
      lastEventId: '7',
    });

    s.close();
  });

  it('sends caller headers plus required SSE headers, defaulting to GET', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeSSEResponse(new MockSSEStream()));

    const s = new FetchStreamer('/events', { headers: { Authorization: 'Bearer t' } });
    await tick();

    const init = fetchFn.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer t');
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(init.headers['Cache-Control']).toBe('no-cache');
    s.close();
  });

  it('does not let the caller override Accept / Cache-Control', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeSSEResponse(new MockSSEStream()));

    const s = new FetchStreamer('/events', {
      headers: { Accept: 'application/json', 'Cache-Control': 'max-age=60' },
    });
    await tick();

    const init = fetchFn.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(init.headers['Cache-Control']).toBe('no-cache');
    s.close();
  });

  it('passes method, body, and credentials for POST', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeSSEResponse(new MockSSEStream()));

    const s = new FetchStreamer('/events', {
      method: 'POST',
      body: 'query',
      withCredentials: true,
    });
    await tick();

    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('query');
    expect(init.credentials).toBe('include');
    s.close();
  });
});

describe('FetchStreamer — lifecycle & close', () => {
  it('treats a clean server close as final (onClose, no reconnect)', async () => {
    const fetchFn = stubFetch();
    const stream = new MockSSEStream();
    fetchFn.mockResolvedValue(makeSSEResponse(stream));

    const onClose = vi.fn();
    new FetchStreamer('/events', { onClose });
    await tick();

    stream.close();
    await tick();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent and fires onClose once', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeSSEResponse(new MockSSEStream()));

    const onClose = vi.fn();
    const s = new FetchStreamer('/events', { onClose });
    await tick();

    s.close();
    s.close();
    s.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an external AbortSignal closes the stream', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeSSEResponse(new MockSSEStream()));

    const ac = new AbortController();
    const onClose = vi.fn();
    new FetchStreamer('/events', { signal: ac.signal, onClose });
    await tick();

    ac.abort();
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('detaches its external-signal listener on manual close (no leak)', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeSSEResponse(new MockSSEStream()));

    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    const s = new FetchStreamer('/events', { signal: ac.signal });
    await tick();

    s.close();
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    // The now-detached listener must not fire close() machinery a second time.
    expect(() => ac.abort()).not.toThrow();
  });

  it('a pre-aborted signal never starts the connection', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeSSEResponse(new MockSSEStream()));

    const ac = new AbortController();
    ac.abort();
    const onClose = vi.fn();
    new FetchStreamer('/events', { signal: ac.signal, onClose });
    await tick();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('FetchStreamer — HTTP & content-type errors', () => {
  it('does not retry a non-retriable status (401)', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeErrorResponse(401, 'Unauthorized'));

    const onError = vi.fn();
    const onClose = vi.fn();
    new FetchStreamer('/events', { onError, onClose });
    await tick();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0];
    expect(err).toBeInstanceOf(FetchStreamerHttpError);
    expect(err.status).toBe(401);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives up immediately when reconnectOnError is false', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeErrorResponse(500, 'Server Error'));

    const onError = vi.fn();
    const onClose = vi.fn();
    new FetchStreamer('/events', { reconnectOnError: false, onError, onClose });
    await tick();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(FetchStreamerHttpError);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a non event-stream Content-Type', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(
      makeSSEResponse(new MockSSEStream(), { contentType: 'application/json' }),
    );

    const onError = vi.fn();
    new FetchStreamer('/events', { reconnectOnError: false, onError });
    await tick();

    const err = onError.mock.calls[0][0];
    expect(err).toBeInstanceOf(FetchStreamerContentTypeError);
    expect(err.contentType).toBe('application/json');
  });
});

describe('FetchStreamer — reconnect & backoff', () => {
  it('retries a retriable failure after the backoff delay', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // zero jitter

    const fetchFn = stubFetch();
    fetchFn
      .mockResolvedValueOnce(makeErrorResponse(503, 'Unavailable'))
      .mockResolvedValueOnce(makeSSEResponse(new MockSSEStream()));

    const onOpen = vi.fn();
    const s = new FetchStreamer('/events', {
      initialRetryMs: 10,
      minRetryMs: 1,
      onOpen,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledTimes(1);

    s.close();
  });

  it('stops after maxRetries consecutive failures', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeErrorResponse(500, 'Server Error'));

    const onClose = vi.fn();
    new FetchStreamer('/events', {
      maxRetries: 2,
      initialRetryMs: 10,
      minRetryMs: 1,
      onClose,
    });

    await vi.advanceTimersByTimeAsync(0); // attempt 1
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10); // attempt 2 (delay = 10)
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15); // attempt 3 (delay = 10 * 1.5)
    expect(fetchFn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1000); // no further attempts
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends Last-Event-ID on reconnect after receiving an id', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const fetchFn = stubFetch();
    const stream1 = new MockSSEStream();
    fetchFn
      .mockResolvedValueOnce(makeSSEResponse(stream1))
      .mockResolvedValueOnce(makeSSEResponse(new MockSSEStream()));

    const s = new FetchStreamer('/events', { initialRetryMs: 10, minRetryMs: 1 });

    await vi.advanceTimersByTimeAsync(0);
    stream1.push('id: 42\ndata: x\n\n');
    await vi.advanceTimersByTimeAsync(0);

    stream1.error(); // simulate a dropped connection
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const init = fetchFn.mock.calls[1][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers['Last-Event-ID']).toBe('42');

    s.close();
  });
});

describe('FetchStreamer — server retry: clamping', () => {
  it('floors a tight retry: 0 at minRetryMs', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const fetchFn = stubFetch();
    const stream1 = new MockSSEStream();
    fetchFn
      .mockResolvedValueOnce(makeSSEResponse(stream1))
      .mockResolvedValueOnce(makeSSEResponse(new MockSSEStream()));

    const s = new FetchStreamer('/events', { minRetryMs: 500, maxRetryMs: 30_000 });

    await vi.advanceTimersByTimeAsync(0);
    stream1.push('retry: 0\ndata: x\n\n');
    await vi.advanceTimersByTimeAsync(0);
    stream1.error();

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchFn).toHaveBeenCalledTimes(1); // clamped — not yet reconnected
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2); // reconnects at minRetryMs

    s.close();
  });

  it('caps an enormous retry: at maxRetryMs', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const fetchFn = stubFetch();
    const stream1 = new MockSSEStream();
    fetchFn
      .mockResolvedValueOnce(makeSSEResponse(stream1))
      .mockResolvedValueOnce(makeSSEResponse(new MockSSEStream()));

    const s = new FetchStreamer('/events', { minRetryMs: 1, maxRetryMs: 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    stream1.push('retry: 999999999\ndata: x\n\n');
    await vi.advanceTimersByTimeAsync(0);
    stream1.error();

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2); // reconnects at maxRetryMs, not 999999999

    s.close();
  });
});

describe('FetchStreamer — connection timeout', () => {
  it('throws FetchStreamerConnectTimeoutError when fetch is too slow', async () => {
    vi.useFakeTimers();
    const fetchFn = stubFetch();
    fetchFn.mockImplementation((_url: string, init: RequestInit) => hangUntilAbort(init));

    const onError = vi.fn();
    new FetchStreamer('/events', {
      connectTimeoutMs: 50,
      reconnectOnError: false,
      onError,
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(FetchStreamerConnectTimeoutError);
  });

  it('connection timeout is retriable', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const fetchFn = stubFetch();
    let attempt = 0;
    fetchFn.mockImplementation((_url: string, init: RequestInit) => {
      attempt += 1;
      if (attempt === 1) return hangUntilAbort(init);
      return Promise.resolve(makeSSEResponse(new MockSSEStream()));
    });

    const s = new FetchStreamer('/events', {
      connectTimeoutMs: 50,
      initialRetryMs: 10,
      minRetryMs: 1,
    });

    await vi.advanceTimersByTimeAsync(50); // first attempt times out
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10); // backoff → second attempt succeeds
    expect(fetchFn).toHaveBeenCalledTimes(2);

    s.close();
  });
});

describe('FetchStreamer — heartbeat timeout', () => {
  it('throws FetchStreamerHeartbeatError on silence, then reconnects', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const fetchFn = stubFetch();
    fetchFn
      .mockResolvedValueOnce(makeSSEResponse(new MockSSEStream()))
      .mockResolvedValueOnce(makeSSEResponse(new MockSSEStream()));

    const onError = vi.fn();
    const s = new FetchStreamer('/events', {
      heartbeatTimeoutMs: 100,
      initialRetryMs: 10,
      minRetryMs: 1,
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100); // silence → heartbeat fires
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(FetchStreamerHeartbeatError);

    await vi.advanceTimersByTimeAsync(10); // backoff → reconnect
    expect(fetchFn).toHaveBeenCalledTimes(2);

    s.close();
  });

  it('resets the heartbeat on each received chunk', async () => {
    vi.useFakeTimers();
    const fetchFn = stubFetch();
    const stream = new MockSSEStream();
    fetchFn.mockResolvedValue(makeSSEResponse(stream));

    const onError = vi.fn();
    const s = new FetchStreamer('/events', { heartbeatTimeoutMs: 100, onError });

    await vi.advanceTimersByTimeAsync(0); // armed to fire at t=100
    await vi.advanceTimersByTimeAsync(80); // t=80
    stream.push('data: keepalive\n\n'); // resets the timer
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(80); // t=160, but reset at 80 → fires at 180

    expect(onError).not.toHaveBeenCalled();
    s.close();
  });
});

describe('FetchStreamer — handler isolation', () => {
  it('a throwing onMessage is reported to onError without tearing down the stream', async () => {
    const fetchFn = stubFetch();
    const stream = new MockSSEStream();
    fetchFn.mockResolvedValue(makeSSEResponse(stream));

    const boom = new Error('handler boom');
    const onMessage = vi.fn(() => {
      throw boom;
    });
    const onError = vi.fn();
    const onClose = vi.fn();
    const s = new FetchStreamer('/events', { onMessage, onError, onClose });
    await tick();

    stream.push('data: one\n\n');
    await tick();
    stream.push('data: two\n\n');
    await tick();

    expect(onMessage).toHaveBeenCalledTimes(2); // still delivering after the first throw
    expect(onError).toHaveBeenCalledWith(boom);
    expect(onClose).not.toHaveBeenCalled(); // connection stayed open
    expect(fetchFn).toHaveBeenCalledTimes(1); // no reconnect triggered
    s.close();
  });

  it('a throwing onError does not break message delivery', async () => {
    const fetchFn = stubFetch();
    const stream = new MockSSEStream();
    fetchFn.mockResolvedValue(makeSSEResponse(stream));

    const onMessage = vi.fn(() => {
      throw new Error('msg');
    });
    const onError = vi.fn(() => {
      throw new Error('err');
    });
    const s = new FetchStreamer('/events', { onMessage, onError });
    await tick();

    stream.push('data: one\n\n');
    await tick();
    stream.push('data: two\n\n');
    await tick();

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    s.close();
  });

  it('a throwing onClose does not throw out of close()', async () => {
    const fetchFn = stubFetch();
    fetchFn.mockResolvedValue(makeSSEResponse(new MockSSEStream()));

    const onClose = vi.fn(() => {
      throw new Error('close boom');
    });
    const s = new FetchStreamer('/events', { onClose });
    await tick();

    expect(() => s.close()).not.toThrow();
  });
});

describe('FetchStreamer — byte decoding', () => {
  it('reassembles a multi-byte character split across reads', async () => {
    const fetchFn = stubFetch();
    const stream = new MockSSEStream();
    fetchFn.mockResolvedValue(makeSSEResponse(stream));

    const onMessage = vi.fn();
    const s = new FetchStreamer('/events', { onMessage });
    await tick();

    // '中' encodes to 3 UTF-8 bytes; split the event mid-character.
    const bytes = new TextEncoder().encode('data: 中\n\n');
    stream.pushBytes(bytes.slice(0, 7)); // 'data: ' + 1 byte of 中
    await tick();
    stream.pushBytes(bytes.slice(7)); // remaining 2 bytes + boundary
    await tick();

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: '中' }));
    s.close();
  });
});
