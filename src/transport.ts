/**
 * Transport — abstract interface for sending and receiving raw frame JSON.
 *
 * Implementations handle the physical connection (WebSocket, SSE, etc.)
 * and expose a minimal surface: send a string, receive strings as an async
 * iterable, close the connection. The client layer handles framing,
 * correlation, and lifecycle on top.
 */

/**
 * A connected transport that can send and receive raw JSON strings.
 *
 * Implementations must:
 * - Deliver received messages via the async iterable
 * - End the iterable when the connection closes (normally or on error)
 * - Allow `send()` to throw if the connection is not open
 * - Make `close()` idempotent
 */
export interface Transport extends AsyncIterable<string> {
  send(data: string): void;
  close(): void;
}

/**
 * Factory function that establishes a connection and returns a Transport.
 *
 * Called by `Client.connect()`. The factory is responsible for completing
 * the handshake (if any) before returning.
 */
export type TransportFactory = (url: string) => Promise<Transport>;

// ---------------------------------------------------------------------------
// WebSocket transport — built-in default
// ---------------------------------------------------------------------------

/**
 * Transport backed by a WebSocket connection.
 *
 * Uses the global `WebSocket` constructor available in browsers and in
 * Node.js 21+. For older Node.js versions, pass a `WebSocket`-compatible
 * constructor via `WebSocketTransport.create()`.
 */
export class WebSocketTransport implements Transport {
  private readonly pending: string[] = [];
  private resolve: ((value: IteratorResult<string>) => void) | undefined;
  private done = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const data = String(event.data);
      if (this.resolve !== undefined) {
        const r = this.resolve;
        this.resolve = undefined;
        r({ value: data, done: false });
      } else {
        this.pending.push(data);
      }
    });

    ws.addEventListener("close", () => {
      this.finish();
    });

    ws.addEventListener("error", () => {
      this.finish();
    });
  }

  /**
   * Connects to `url` and resolves when the WebSocket is open.
   */
  static create(url: string): Promise<Transport> {
    return new Promise<Transport>((resolve, reject) => {
      const ws = new WebSocket(url);

      const onOpen = () => {
        cleanup();
        resolve(new WebSocketTransport(ws));
      };

      const onError = (event: Event) => {
        cleanup();
        reject(new Error(`WebSocket connection failed: ${url}`));
      };

      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.resolve !== undefined) {
      const r = this.resolve;
      this.resolve = undefined;
      r({ value: undefined as unknown as string, done: true });
    }
  }

  async next(): Promise<IteratorResult<string>> {
    if (this.pending.length > 0) {
      return { value: this.pending.shift()!, done: false };
    }
    if (this.done) {
      return { value: undefined as unknown as string, done: true };
    }
    return new Promise<IteratorResult<string>>((resolve) => {
      this.resolve = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return { next: () => this.next() };
  }
}
