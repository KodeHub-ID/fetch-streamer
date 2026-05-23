const encoder = new TextEncoder();

/**
 * Controllable ReadableStream of Uint8Array that simulates an SSE server body.
 * Call push() to enqueue text chunks, close() to end the stream cleanly,
 * and error() to simulate a network interruption.
 */
export class MockSSEStream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly readable: ReadableStream<Uint8Array>;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        this.controller = ctrl;
      },
    });
  }

  push(text: string): void {
    this.controller.enqueue(encoder.encode(text));
  }

  /** Enqueue raw bytes — used to split a multi-byte character across reads. */
  pushBytes(bytes: Uint8Array): void {
    this.controller.enqueue(bytes);
  }

  close(): void {
    this.controller.close();
  }

  error(reason: unknown = new Error('stream aborted')): void {
    this.controller.error(reason);
  }
}

/**
 * Build a 200 OK Response with Content-Type: text/event-stream backed by the
 * given MockSSEStream. Pass overrides to simulate error conditions.
 */
export function makeSSEResponse(
  stream: MockSSEStream,
  opts: { status?: number; statusText?: string; contentType?: string } = {},
): Response {
  return new Response(stream.readable, {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    headers: {
      'Content-Type': opts.contentType ?? 'text/event-stream',
    },
  });
}

/**
 * A Response with the given status and no body. Used to simulate HTTP error
 * responses where the library inspects response.ok and throws immediately.
 */
export function makeErrorResponse(status: number, statusText = ''): Response {
  return new Response(null, { status, statusText });
}
