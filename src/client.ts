/**
 * Client — connects to a Muninn frame server and provides a streaming API.
 *
 * The client manages a single transport connection, sends request frames,
 * correlates response frames back to their originating streams via `parent_id`,
 * and exposes `call()` / `collect()` / `first()` conveniences.
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

      const parentId = frame.parent_id;
      if (parentId === undefined) continue;

      const stream = this.pending.get(parentId);
      if (stream === undefined) continue;

      stream._push(frame);

      if (isTerminalStatus(frame.status)) {
        this.pending.delete(parentId);
      }
    }

    // Transport closed — terminate all pending streams
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
