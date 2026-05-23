import { describe, it, expect } from 'vitest';
import {
  FetchStreamerHttpError,
  FetchStreamerContentTypeError,
  FetchStreamerBufferError,
  FetchStreamerConnectTimeoutError,
  FetchStreamerHeartbeatError,
} from '../errors';

describe('FetchStreamerHttpError', () => {
  it('formats message with status and statusText', () => {
    expect(new FetchStreamerHttpError(404, 'Not Found').message).toBe(
      'FetchStreamer: HTTP 404 Not Found',
    );
  });

  it('exposes status as a typed field', () => {
    expect(new FetchStreamerHttpError(401, 'Unauthorized').status).toBe(401);
  });

  it('exposes statusText as a typed field', () => {
    expect(new FetchStreamerHttpError(403, 'Forbidden').statusText).toBe('Forbidden');
  });

  it('has name FetchStreamerHttpError', () => {
    expect(new FetchStreamerHttpError(500, '').name).toBe('FetchStreamerHttpError');
  });

  it('is an instance of Error', () => {
    expect(new FetchStreamerHttpError(500, '')).toBeInstanceOf(Error);
  });

  it('name is own property so instanceof works across module boundaries', () => {
    const err = new FetchStreamerHttpError(500, '');
    expect(Object.prototype.hasOwnProperty.call(err, 'name')).toBe(true);
  });
});

describe('FetchStreamerContentTypeError', () => {
  it('formats message with the received content type', () => {
    expect(new FetchStreamerContentTypeError('application/json').message).toBe(
      'FetchStreamer: Expected "text/event-stream", got "application/json"',
    );
  });

  it('formats message when content type is null', () => {
    expect(new FetchStreamerContentTypeError(null).message).toBe(
      'FetchStreamer: Expected "text/event-stream", got "null"',
    );
  });

  it('exposes contentType as a typed field', () => {
    expect(new FetchStreamerContentTypeError('text/html').contentType).toBe('text/html');
  });

  it('exposes null contentType as a typed field', () => {
    expect(new FetchStreamerContentTypeError(null).contentType).toBeNull();
  });

  it('has name FetchStreamerContentTypeError', () => {
    expect(new FetchStreamerContentTypeError(null).name).toBe('FetchStreamerContentTypeError');
  });

  it('is an instance of Error', () => {
    expect(new FetchStreamerContentTypeError(null)).toBeInstanceOf(Error);
  });
});

describe('FetchStreamerBufferError', () => {
  it('formats message with the limit', () => {
    expect(new FetchStreamerBufferError(1_048_576).message).toBe(
      'FetchStreamer: buffer exceeded 1048576 code units — stream discarded',
    );
  });

  it('exposes limitLength as a typed field', () => {
    expect(new FetchStreamerBufferError(512).limitLength).toBe(512);
  });

  it('has name FetchStreamerBufferError', () => {
    expect(new FetchStreamerBufferError(0).name).toBe('FetchStreamerBufferError');
  });

  it('is an instance of Error', () => {
    expect(new FetchStreamerBufferError(0)).toBeInstanceOf(Error);
  });
});

describe('FetchStreamerConnectTimeoutError', () => {
  it('formats message with the timeout', () => {
    expect(new FetchStreamerConnectTimeoutError(5_000).message).toBe(
      'FetchStreamer: connection timed out after 5000 ms',
    );
  });

  it('exposes timeoutMs as a typed field', () => {
    expect(new FetchStreamerConnectTimeoutError(3_000).timeoutMs).toBe(3_000);
  });

  it('has name FetchStreamerConnectTimeoutError', () => {
    expect(new FetchStreamerConnectTimeoutError(0).name).toBe('FetchStreamerConnectTimeoutError');
  });

  it('is an instance of Error', () => {
    expect(new FetchStreamerConnectTimeoutError(0)).toBeInstanceOf(Error);
  });
});

describe('FetchStreamerHeartbeatError', () => {
  it('formats message with the timeout', () => {
    expect(new FetchStreamerHeartbeatError(30_000).message).toBe(
      'FetchStreamer: heartbeat timed out after 30000 ms',
    );
  });

  it('exposes timeoutMs as a typed field', () => {
    expect(new FetchStreamerHeartbeatError(10_000).timeoutMs).toBe(10_000);
  });

  it('has name FetchStreamerHeartbeatError', () => {
    expect(new FetchStreamerHeartbeatError(0).name).toBe('FetchStreamerHeartbeatError');
  });

  it('is an instance of Error', () => {
    expect(new FetchStreamerHeartbeatError(0)).toBeInstanceOf(Error);
  });
});
