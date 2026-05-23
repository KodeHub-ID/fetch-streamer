/** Server responded with a non-2xx status code. */
export class FetchStreamerHttpError extends Error {
  override readonly name = 'FetchStreamerHttpError';

  constructor(
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(`FetchStreamer: HTTP ${status} ${statusText}`);
  }
}

/** Server responded with a Content-Type other than text/event-stream. */
export class FetchStreamerContentTypeError extends Error {
  override readonly name = 'FetchStreamerContentTypeError';

  constructor(public readonly contentType: string | null) {
    super(
      `FetchStreamer: Expected "text/event-stream", got "${contentType ?? 'null'}"`,
    );
  }
}

/** The SSE text buffer grew beyond the configured maxBufferLength limit. */
export class FetchStreamerBufferError extends Error {
  override readonly name = 'FetchStreamerBufferError';

  constructor(public readonly limitLength: number) {
    super(`FetchStreamer: buffer exceeded ${limitLength} code units — stream discarded`);
  }
}

/** fetch() did not resolve within the configured connectTimeoutMs window. */
export class FetchStreamerConnectTimeoutError extends Error {
  override readonly name = 'FetchStreamerConnectTimeoutError';

  constructor(public readonly timeoutMs: number) {
    super(`FetchStreamer: connection timed out after ${timeoutMs} ms`);
  }
}

/** No SSE data (including comments) was received within the heartbeatTimeoutMs window. */
export class FetchStreamerHeartbeatError extends Error {
  override readonly name = 'FetchStreamerHeartbeatError';

  constructor(public readonly timeoutMs: number) {
    super(`FetchStreamer: heartbeat timed out after ${timeoutMs} ms`);
  }
}
