export interface SSEEvent {
  /** Event type name. Defaults to "message". Determined by `event:` field. */
  type: string;
  /** Raw data payload. Multiline data fields are joined with "\n". */
  data: string;
  /** Most recent event ID received. Sent as `Last-Event-ID` header on reconnect. */
  lastEventId: string;
}

export interface FetchStreamerOptions {
  /** Additional HTTP request headers (e.g. Authorization, X-Share-Token). */
  headers?: Record<string, string>;
  /** HTTP method. Defaults to "GET". */
  method?: 'GET' | 'POST';
  /** Request body string. Only meaningful when method is "POST". */
  body?: string;
  /** Include cookies in cross-origin requests. Defaults to false. */
  withCredentials?: boolean;
  /** Attempt to reconnect after connection failure. Defaults to true. */
  reconnectOnError?: boolean;
  /** Maximum reconnect attempts before permanently closing. Unlimited by default. */
  maxRetries?: number;
  /** Initial reconnect delay in ms. Defaults to 3000. */
  initialRetryMs?: number;
  /** Backoff ceiling in ms. Defaults to 30000. */
  maxRetryMs?: number;
  /**
   * Lower bound for the reconnect delay in ms. Floors both any `retry:` directive
   * sent by the server and the locally jittered backoff, so neither a malicious
   * server nor negative jitter can produce a tight reconnect loop.
   * Defaults to 500.
   */
  minRetryMs?: number;
  /**
   * Maximum SSE text buffer size in UTF-16 code units (JS string `.length`).
   * For ASCII-only streams this equals bytes; for multi-byte Unicode (CJK,
   * emoji) the effective byte limit is higher — see docs for details.
   * If exceeded (e.g. server sends an event with no blank-line terminator),
   * the buffer is discarded and FetchStreamerBufferError is thrown.
   * Defaults to 1_048_576 code units.
   */
  maxBufferLength?: number;
  /**
   * Maximum time in ms to wait for `fetch()` to resolve (headers received).
   * If the server does not respond within this window, the connection attempt
   * is aborted and FetchStreamerConnectTimeoutError is thrown, then retried
   * with exponential backoff. No timeout by default.
   */
  connectTimeoutMs?: number;
  /**
   * Maximum time in ms allowed between any two received chunks (including SSE
   * comments). If no data arrives within this window, the stream is cancelled
   * and FetchStreamerHeartbeatError is thrown, then retried with exponential
   * backoff. No timeout by default.
   */
  heartbeatTimeoutMs?: number;
  /**
   * Called once when a connection opens and headers are received. May be async;
   * it is awaited before reading begins. If it throws, the connection attempt is
   * treated as failed and retried (use this to abort setup that must succeed).
   */
  onOpen?: (response: Response) => void | Promise<void>;
  /**
   * Called for each complete, dispatched SSE event. Exceptions thrown here are
   * caught and forwarded to onError; they never tear down the connection, so a
   * bug in event handling cannot trigger an unwanted reconnect loop.
   */
  onMessage?: (event: SSEEvent) => void;
  /**
   * Called on any connection error, non-retriable HTTP response, or an exception
   * thrown by onMessage. Its own exceptions are swallowed so a buggy handler
   * cannot break reconnection.
   */
  onError?: (error: unknown) => void;
  /** Called when the stream is permanently closed (no further reconnects). */
  onClose?: () => void;
  /** Caller-controlled AbortSignal. Aborting it is equivalent to calling `.close()`. */
  signal?: AbortSignal;
}
