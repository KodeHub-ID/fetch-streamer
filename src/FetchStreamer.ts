import { createSSEParser, type ParsedEvent } from './parser';
import {
  FetchStreamerHttpError,
  FetchStreamerContentTypeError,
  FetchStreamerConnectTimeoutError,
  FetchStreamerHeartbeatError,
} from './errors';
import type { FetchStreamerOptions } from './types';

// Keys match FetchStreamerOptions names intentionally — diff is immediate.
const DEFAULTS = {
  initialRetryMs: 3_000,
  maxRetryMs: 30_000,
  minRetryMs: 500,
  maxBufferLength: 1_048_576,
} as const;

// Status codes indicating a permanent client-side failure; never retry.
const NON_RETRIABLE_STATUS = new Set([401, 403, 404, 405, 410, 422]);

// Numeric options resolved once at construction so no `?? DEFAULT` at call sites.
interface ResolvedConfig {
  reconnectOnError: boolean;
  maxRetries: number | undefined;
  initialRetryMs: number;
  maxRetryMs: number;
  minRetryMs: number;
  maxBufferLength: number;
  connectTimeoutMs: number | undefined;
  heartbeatTimeoutMs: number | undefined;
}

export class FetchStreamer {
  private readonly cfg: ResolvedConfig;
  private readonly abortController = new AbortController();
  private closed = false;
  private retryCount = 0;
  private lastEventId = '';
  private retryMs: number;
  // Stored so close() can detach it from the caller's signal — see close().
  private readonly onExternalAbort = () => this.close();

  constructor(
    private readonly url: string,
    private readonly options: FetchStreamerOptions = {},
  ) {
    this.cfg = {
      reconnectOnError: options.reconnectOnError ?? true,
      maxRetries: options.maxRetries,
      initialRetryMs: options.initialRetryMs ?? DEFAULTS.initialRetryMs,
      maxRetryMs: options.maxRetryMs ?? DEFAULTS.maxRetryMs,
      minRetryMs: options.minRetryMs ?? DEFAULTS.minRetryMs,
      maxBufferLength: options.maxBufferLength ?? DEFAULTS.maxBufferLength,
      connectTimeoutMs: options.connectTimeoutMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    };
    this.retryMs = this.cfg.initialRetryMs;

    // { once: true } drops the listener after an abort fires; close() also detaches
    // it explicitly so a manually-closed stream never lingers on the caller's signal.
    options.signal?.addEventListener('abort', this.onExternalAbort, { once: true });
    // addEventListener does not fire retroactively — an already-aborted signal
    // must be checked explicitly so the run loop does not start.
    if (options.signal?.aborted) {
      this.close();
    } else {
      void this.run();
    }
  }

  /** Permanently closes the stream. Idempotent — safe to call multiple times. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort(); // also wakes up any sleeping sleep()
    // Detach from the caller's signal now (not only when it aborts) so a long-lived
    // external signal never retains this instance after a manual close().
    this.options.signal?.removeEventListener('abort', this.onExternalAbort);
    // A throwing onClose must not leave the instance half-closed or surface as an
    // unhandled rejection from the abort/signal paths that call close().
    try {
      this.options.onClose?.();
    } catch {
      /* swallow — there is no further channel to report a teardown-handler bug */
    }
  }

  /**
   * Invokes the caller's onError without letting a throwing handler escape into
   * the reconnect loop (which would surface as an unhandled rejection).
   */
  private emitError(err: unknown): void {
    try {
      this.options.onError?.(err);
    } catch {
      /* swallow — a buggy onError must not break reconnection */
    }
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      try {
        await this.openConnection();
        // Server closed the stream cleanly (done === true from reader). Do not reconnect.
        this.close();
        return;
      } catch (err) {
        // close() sets this.closed = true before abort(), so this single check suffices.
        if (this.closed) return;

        this.emitError(err);

        if (this.shouldGiveUp(err)) {
          this.close();
          return;
        }

        this.retryCount++;

        // ±25% jitter prevents thundering herd when many clients reconnect simultaneously.
        // Floored at minRetryMs so negative jitter can never undercut the configured minimum.
        const jitter = (Math.random() - 0.5) * 0.5 * this.retryMs;
        const delay = Math.max(this.cfg.minRetryMs, this.retryMs + jitter);
        await this.sleep(delay);

        if (!this.closed) {
          this.retryMs = Math.min(this.retryMs * 1.5, this.cfg.maxRetryMs);
        }
      }
    }
  }

  private shouldGiveUp(err: unknown): boolean {
    if (!this.cfg.reconnectOnError) return true;
    if (err instanceof FetchStreamerHttpError && NON_RETRIABLE_STATUS.has(err.status)) return true;
    if (this.cfg.maxRetries !== undefined && this.retryCount >= this.cfg.maxRetries) return true;
    return false;
  }

  /**
   * Returns a signal that fires on close() OR after connectTimeoutMs, whichever
   * comes first. The caller must invoke the returned cancel() to clear the timer
   * whether or not fetch() succeeds, preventing a timer leak.
   */
  private buildConnectSignal(): { signal: AbortSignal; cancel: () => void } {
    if (this.cfg.connectTimeoutMs === undefined) {
      return { signal: this.abortController.signal, cancel: () => undefined };
    }

    const timeoutMs = this.cfg.connectTimeoutMs;
    const timeoutController = new AbortController();

    // Propagate close() into timeoutController so fetch() only needs one signal.
    // Uses a listener instead of AbortSignal.any() for Node.js < 20 compatibility.
    const onAbort = () => timeoutController.abort(this.abortController.signal.reason);
    this.abortController.signal.addEventListener('abort', onAbort, { once: true });

    const id = setTimeout(() => {
      timeoutController.abort(new FetchStreamerConnectTimeoutError(timeoutMs));
    }, timeoutMs);

    const cancel = () => {
      clearTimeout(id);
      this.abortController.signal.removeEventListener('abort', onAbort);
    };

    return { signal: timeoutController.signal, cancel };
  }

  private async openConnection(): Promise<void> {
    const { signal, cancel } = this.buildConnectSignal();

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: this.options.method ?? 'GET',
        headers: this.buildHeaders(),
        body: this.options.body,
        credentials: this.options.withCredentials ? 'include' : 'same-origin',
        signal,
      });
    } catch (err) {
      cancel();
      // Re-throw the connect-timeout error we set as the abort reason so the
      // caller sees FetchStreamerConnectTimeoutError rather than a generic DOMException.
      if (!this.closed && err instanceof DOMException && err.name === 'AbortError') {
        const reason = signal.reason;
        if (reason instanceof FetchStreamerConnectTimeoutError) throw reason;
      }
      throw err;
    }
    cancel();

    if (!response.ok) {
      throw new FetchStreamerHttpError(response.status, response.statusText);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      throw new FetchStreamerContentTypeError(response.headers.get('content-type'));
    }

    if (!response.body) {
      throw new Error('FetchStreamer: response body is null');
    }

    await this.options.onOpen?.(response);

    // Guard: close() may have been called during the async onOpen.
    // Without this check we would create a reader and immediately cancel it.
    if (this.closed) return;

    this.retryMs = this.cfg.initialRetryMs;
    this.retryCount = 0;

    await this.readStream(response.body.getReader());
  }

  private buildHeaders(): Record<string, string> {
    // Required SSE headers are placed AFTER options.headers so the caller
    // cannot accidentally override Accept or Cache-Control.
    const headers: Record<string, string> = {
      ...this.options.headers,
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    return headers;
  }

  private handleParsedEvent(parsed: ParsedEvent): void {
    // undefined = field absent (no change); '' = explicit reset per spec.
    if (parsed.id !== undefined) this.lastEventId = parsed.id;

    if (parsed.retry !== undefined) {
      // Clamp between minRetryMs and maxRetryMs — a server cannot force either a
      // tight reconnect loop (retry: 0) or a near-infinite wait (retry: 86400000).
      this.retryMs = Math.min(
        Math.max(parsed.retry, this.cfg.minRetryMs),
        this.cfg.maxRetryMs,
      );
    }

    // lastEventId / retryMs are updated above and persist regardless of whether
    // the handler throws. A buggy onMessage is reported via onError but must not
    // tear down a healthy connection, so it is isolated from the read loop.
    try {
      this.options.onMessage?.({
        type: parsed.type,
        data: parsed.data,
        lastEventId: this.lastEventId,
      });
    } catch (err) {
      this.emitError(err);
    }
  }

  private async readStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const push = createSSEParser(
      (parsed) => this.handleParsedEvent(parsed),
      this.cfg.maxBufferLength,
    );

    // Heartbeat timeout: reset on every chunk; fire by cancelling the reader so
    // the finally block still runs normally before we throw.
    const heartbeatTimeoutMs = this.cfg.heartbeatTimeoutMs;
    let heartbeatExpired = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;

    const resetHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      if (heartbeatTimeoutMs !== undefined) {
        heartbeatTimer = setTimeout(() => {
          heartbeatExpired = true;
          void reader.cancel();
        }, heartbeatTimeoutMs);
      }
    };

    // Guarantee close() immediately cancels the reader regardless of which fetch
    // signal was used. When connectTimeoutMs is set, buildConnectSignal() disconnects
    // its internal controller after the connection phase, making this.abortController
    // the only reliable path for close() to reach the reader.
    const onAbort = () => void reader.cancel();
    this.abortController.signal.addEventListener('abort', onAbort, { once: true });

    resetHeartbeat();

    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any bytes the streaming decoder held back (a trailing
          // multi-byte sequence completed exactly at the stream's end).
          push(decoder.decode());
          break;
        }
        resetHeartbeat();
        push(decoder.decode(value, { stream: true }));
      }
    } finally {
      this.abortController.signal.removeEventListener('abort', onAbort);
      clearTimeout(heartbeatTimer);
      // Cancel unconditionally: covers clean server-close, thrown errors, close() mid-read.
      await reader.cancel();
    }

    // Throw AFTER finally so reader.cancel() always runs first.
    if (heartbeatExpired && heartbeatTimeoutMs !== undefined) {
      throw new FetchStreamerHeartbeatError(heartbeatTimeoutMs);
    }
  }

  /**
   * Resolves after `ms` milliseconds.
   * Cancels immediately if close() is called, so teardown is never blocked
   * by a long backoff interval (up to maxRetryMs = 30 s by default).
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abortController.signal;
      let id: ReturnType<typeof setTimeout>;
      const onAbort = () => {
        clearTimeout(id);
        resolve();
      };
      id = setTimeout(() => {
        // Normal completion: detach so listeners don't accumulate one-per-retry
        // on the long-lived abort signal until close() is finally called.
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
