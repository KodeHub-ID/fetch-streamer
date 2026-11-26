// Runs against a real HTTP server: abort propagation, socket lifetime and header
// encoding cannot be observed with a mocked fetch.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { FetchStreamer } from '../FetchStreamer.js';
import type { FetchStreamerOptions } from '../types.js';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition() && Date.now() < end) await wait(5);
}

let server: Server;
let url: string;
let requests: IncomingMessage[];
let sockets: { open: number }; // per server, so a late close from an earlier test cannot skew it
let handler: (res: ServerResponse) => void;
let unhandled: unknown[];
let streams: FetchStreamer[];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

const sse = (res: ServerResponse, text = 'data: 1\n\n') => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(text);
};
/** Responds and then never ends the body. */
const hanging = (status: number, type: string) => (res: ServerResponse) => {
  res.writeHead(status, { 'content-type': type });
  res.write('x');
};
function connect(options: FetchStreamerOptions): FetchStreamer {
  const stream = new FetchStreamer(url, { initialRetryMs: 20, maxRetryMs: 20, minRetryMs: 1, ...options });
  streams.push(stream);
  return stream;
}

beforeEach(async () => {
  requests = [];
  streams = [];
  unhandled = [];
  const counter = (sockets = { open: 0 });
  handler = (res) => sse(res);
  process.on('unhandledRejection', onUnhandled);
  server = createServer((req, res) => {
    requests.push(req);
    counter.open++;
    res.on('close', () => counter.open--);
    handler(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});

afterEach(async () => {
  streams.forEach((s) => s.close());
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  process.off('unhandledRejection', onUnhandled);
});

describe.each([
  ['without connectTimeoutMs', {}],
  ['with connectTimeoutMs', { connectTimeoutMs: 5000 }],
])('close() %s', (_name, base: FetchStreamerOptions) => {
  it.each(['close()', 'close() inside onMessage', 'external signal'])(
    'mid-stream via %s: no unhandled rejection, no error, connection released',
    async (how) => {
      const controller = new AbortController();
      const errors: unknown[] = [];
      let received = 0;
      const stream: FetchStreamer = connect({
        ...base,
        signal: controller.signal,
        heartbeatTimeoutMs: 5000,
        onError: (e) => errors.push(e),
        onMessage: () => {
          received++;
          if (how === 'close() inside onMessage') stream.close();
        },
      });
      await until(() => received === 1);
      if (how === 'close()') stream.close();
      if (how === 'external signal') controller.abort();
      await until(() => sockets.open === 0);
      await wait(20);
      expect(unhandled).toEqual([]);
      expect(errors).toEqual([]);
      expect(sockets.open).toBe(0);
    },
  );

  it('during a never-settling onOpen releases the connection', async () => {
    let opened = false;
    const stream = connect({ ...base, onOpen: () => { opened = true; return new Promise<void>(() => {}); } });
    await until(() => opened);
    stream.close();
    await until(() => sockets.open === 0);
    expect(sockets.open).toBe(0);
  });

  it.each([
    ['an error status', hanging(500, 'text/plain')],
    ['a wrong content type', hanging(200, 'text/html')],
  ])('retries after %s do not pile up connections', async (_case, respond) => {
    handler = respond;
    connect(base);
    await until(() => requests.length >= 5);
    expect(requests.length).toBeGreaterThanOrEqual(5);
    expect(sockets.open).toBeLessThanOrEqual(1);
  });

  it('retries after a throwing onOpen do not pile up connections', async () => {
    connect({ ...base, onOpen: () => { throw new Error('setup failed'); } });
    await until(() => requests.length >= 5);
    expect(sockets.open).toBeLessThanOrEqual(1);
  });
});

describe('Last-Event-ID on reconnect', () => {
  /** First response sends `id` then drops; returns the header seen on the second request. */
  async function reconnectWithId(id: string) {
    handler = (res) => {
      if (requests.length > 1) return sse(res);
      sse(res, `id: ${id}\ndata: a\n\n`);
      setTimeout(() => res.destroy(), 20);
    };
    connect({});
    await until(() => requests.length >= 2);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    return requests[1].headers['last-event-id'] as string | undefined;
  }
  // Node exposes header bytes as latin1; decode them back to what was on the wire.
  const asUtf8 = (header: string | undefined) => Buffer.from(header ?? '', 'latin1').toString('utf8');

  it.each(['42', 'café', '日本-1', '🚀'])('sends %s as UTF-8', async (id) => {
    expect(asUtf8(await reconnectWithId(id))).toBe(id);
  });

  it('omits an id that cannot be a header value, and still reconnects', async () => {
    expect(await reconnectWithId('a\u0001b')).toBeUndefined();
  });
});
