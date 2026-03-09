/**
 * Client — connects to a Muninn frame server and provides a streaming API.
 *
 * The client manages a single transport connection, sends request frames,
 * correlates response frames back to their originating streams via `parent_id`,
 * and exposes `call()` / `collect()` / `first()` conveniences.
 *
 * Ping mechanics are handled privately:
 *
 * - KEEPALIVE (client → server): Every 100ms, the client sends a ping frame
 *   per active stream reporting how many frames the consumer has pulled. The
 *   server uses this for per-stream backpressure (pause/resume based on the
 *   gap between items sent and items acked).
 *
 * - HEARTBEAT (server → client): The server periodically sends a ping frame
 *   with server_ts and seq. If no heartbeat arrives within the timeout, the
 *   client considers the server dead and closes the transport.
 *
 * The consumer never sees ping frames.
 */

import {
  type Frame,
  type JsonObject,
  encodeFrame,
  decodeFrame,
  isTerminalStatus
} from "muninn-frames-ts";

import type { Transport, TransportFactory } from "./transport.js";
import { WebSocketTransport } from "./transport.js";
import { ClientStream } from "./stream.js";
import { PingManager, isPingFrame } from "./ping.js";

// ---------------------------------------------------------------------------
// ClientOptions
// ---------------------------------------------------------------------------

export interface ClientOptions {
  /**
   * Transport factory. Defaults to `WebSocketTransport.create`.
   * Override for custom transports (SSE, IPC, mock).
   */
  transport?: TransportFactory;
}

// ---------------------------------------------------------------------------
// CallOptions
// ---------------------------------------------------------------------------

export interface CallOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class Client {
  private transport: Transport | undefined;
  private readonly pending = new Map<string, ClientStream>();
  private receiveLoop: Promise<void> | undefined;
  private pingManager: PingManager | undefined;
  private closed = false;

  private constructor(
    private readonly url: string,
    private readonly factory: TransportFactory
  ) {}

  /**
   * Creates and connects a client to the given URL.
   *
   * @param url - Server URL (e.g. `ws://localhost:8080`).
   * @param options - Optional transport factory override.
   */
  static async connect(url: string, options: ClientOptions = {}): Promise<Client> {
    const factory = options.transport ?? WebSocketTransport.create;
    const client = new Client(url, factory);
    await client.open();
    return client;
  }

  /**
   * Sends a request and returns an async iterable stream of responses.
   *
   * @param call - Call string in `prefix:verb` format (e.g. `"board:list"`).
   * @param data - Optional request payload.
   * @param options - Optional abort signal for cooperative cancellation.
   */
  call(call: string, data: JsonObject = {}, options: CallOptions = {}): ClientStream {
    if (this.transport === undefined) {
      throw new Error("Client is not connected");
    }

    const frame = makeRequest(call, data);
    const stream = new ClientStream(frame);
    this.pending.set(frame.id, stream);

    this.transport.send(encodeFrame(frame));

    if (options.signal !== undefined) {
      const onAbort = () => {
        this.sendCancel(frame);
      };

      if (options.signal.aborted) {
        this.sendCancel(frame);
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    return stream;
  }

  /**
   * Sends a request and collects all responses up to the terminal frame.
   */
  async collect(call: string, data: JsonObject = {}, options: CallOptions = {}): Promise<Frame[]> {
    return this.call(call, data, options).collect();
  }

  /**
   * Sends a request and returns the first response frame, then closes the stream.
   */
  async first(call: string, data: JsonObject = {}, options: CallOptions = {}): Promise<Frame | undefined> {
    const stream = this.call(call, data, options);
    const result = await stream.recv();
    stream.close();
    return result;
  }

  /**
   * Closes the connection and all pending streams.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Stop ping timers before closing transport to avoid sending pings
    // on a closing/closed connection.
    this.pingManager?.stop();

    this.transport?.close();
    for (const stream of this.pending.values()) {
      stream._close();
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async open(): Promise<void> {
    this.transport = await this.factory(this.url);

    // Create the ping manager. It holds a reference to the transport (for
    // sending keepalive pings) and the pending streams map (for reading
    // each stream's consumed count). The heartbeat timeout callback closes
    // the transport, which ends the receive loop and cleans up everything.
    this.pingManager = new PingManager(
      this.transport,
      this.pending,
      () => this.close()
    );
    this.pingManager.start();

    this.receiveLoop = this.receive();
  }

  private async receive(): Promise<void> {
    if (this.transport === undefined) return;

    for await (const data of this.transport) {
      let frame: Frame;
      try {
        frame = decodeFrame(data);
      } catch {
        continue;
      }

      // Filter ping frames — never deliver to consumer streams.
      //
      // Ping frames use call: "ping" and come in two flavors:
      // - No parent_id: server heartbeat → update watchdog
      // - Has parent_id: shouldn't happen inbound (client sends these),
      //   but ignore gracefully if it does.
      if (isPingFrame(frame)) {
        if (frame.parent_id === undefined) {
          this.pingManager?.onHeartbeat(frame);
        }
        continue;
      }

      // Regular response frame — correlate to pending stream via parent_id.
      const parentId = frame.parent_id;
      if (parentId === undefined) continue;

      const stream = this.pending.get(parentId);
      if (stream === undefined) continue;

      stream._push(frame);

      // Terminal frame closes the stream. Remove from pending so keepalive
      // pings stop being sent for this stream on the next timer tick.
      if (isTerminalStatus(frame.status)) {
        this.pending.delete(parentId);
      }
    }

    // Transport closed — stop pings and terminate all pending streams.
    this.pingManager?.stop();
    for (const stream of this.pending.values()) {
      stream._close();
    }
    this.pending.clear();
  }

  private sendCancel(requestFrame: Frame): void {
    if (this.transport === undefined) return;
    const cancel: Frame = {
      id: crypto.randomUUID(),
      parent_id: requestFrame.id,
      created_ms: Date.now(),
      expires_in: requestFrame.expires_in,
      call: requestFrame.call,
      status: "cancel",
      data: {}
    };
    try {
      this.transport.send(encodeFrame(cancel));
    } catch {
      // Transport may already be closed
    }
  }
}

// ---------------------------------------------------------------------------
// Private request factory
// ---------------------------------------------------------------------------

function makeRequest(call: string, data: JsonObject): Frame {
  return {
    id: crypto.randomUUID(),
    created_ms: Date.now(),
    expires_in: 0,
    call,
    status: "request",
    data
  };
}
