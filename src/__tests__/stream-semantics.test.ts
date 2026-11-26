import { afterEach, describe, it, expect, vi } from 'vitest';
import { FetchStreamer } from '../FetchStreamer.js';
import { createSSEParser, type ParsedEvent } from '../parser.js';
import { FetchStreamerHttpError } from '../errors.js';
import { MockSSEStream, makeSSEResponse, makeErrorResponse } from './helpers/MockSSEStream.js';

// Expected values are what the browser's native EventSource does for the same input.
const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const fast = { initialRetryMs: 5, maxRetryMs: 5, minRetryMs: 1 };

describe('empty event name', () => {
  it.each(['event:\ndata: a\n\n', 'event: \ndata: a\n\n', 'event: x\nevent\ndata: a\n\n'])(
    'dispatches %j as "message"',
    (wire) => {
      const events: ParsedEvent[] = [];
      createSSEParser((e) => events.push(e), 1000)(wire);
      expect(events).toMatchObject([{ type: 'message', data: 'a' }]);
    },
  );
});

describe('id: in a block without data', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Streams `wire`, drops the connection, and returns what the reconnect sends. */
  async function afterDrop(wire: string) {
    const first = new MockSSEStream();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(makeSSEResponse(first))
      .mockImplementation(async () => makeSSEResponse(new MockSSEStream()));
    vi.stubGlobal('fetch', fetchFn);
    const onMessage = vi.fn();
    const s = new FetchStreamer('/e', { ...fast, onMessage });
    await wait();
    first.push(wire);
    await wait();
    first.error();
    await wait(30);
    s.close();
    const headers = fetchFn.mock.calls[1][1].headers as Record<string, string>;
    return { sent: headers['Last-Event-ID'], onMessage };
  }

  it('advances Last-Event-ID without dispatching an event', async () => {
    const { sent, onMessage } = await afterDrop('id: 5\ndata: a\n\nid: 9\n\n');
    expect(sent).toBe('9');
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('resets Last-Event-ID with an empty id', async () => {
    expect((await afterDrop('id: 5\ndata: a\n\nid:\n\n')).sent).toBeUndefined();
  });

  it('keeps the previous id for blocks that carry none', async () => {
    expect((await afterDrop('id: 5\ndata: a\n\n: ping\n\nevent: x\n\n')).sent).toBe('5');
  });

  it('ignores an id whose block was never terminated', async () => {
    expect((await afterDrop('id: 5\ndata: a\n\nid: 9\n')).sent).toBe('5');
  });
});

describe('HTTP 204', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stops reconnecting: it is how a server tells the client to go away', async () => {
    const fetchFn = vi.fn(async () => makeErrorResponse(204));
    vi.stubGlobal('fetch', fetchFn);
    const onError = vi.fn();
    const onClose = vi.fn();
    const onOpen = vi.fn();
    new FetchStreamer('/e', { ...fast, onError, onClose, onOpen });
    await wait(40);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(FetchStreamerHttpError));
    expect((onError.mock.calls[0][0] as FetchStreamerHttpError).status).toBe(204);
  });
});
