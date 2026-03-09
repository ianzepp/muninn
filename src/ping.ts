/**
 * Ping — bidirectional ping mechanics for the client.
 *
 * Two independent ping directions flow over the same transport:
 *
 * 1. KEEPALIVE (client → server):
 *    - A timer fires every PING_INTERVAL_MS (100ms).
 *    - For each active ClientStream, the client sends a ping frame with
 *      `parent_id` set to the stream's request id and `data.consumed` set
 *      to the number of frames the consumer has actually pulled via next().
 *    - The server uses this to drive per-stream backpressure: if the gap
 *      between items sent and items acked exceeds its high-water mark, it
 *      pauses the producing handler until the gap drops to low-water.
 *    - If keepalive pings stop arriving, the server detects a stalled client
 *      and can abort the stream (ETIMEDOUT).
 *
 * 2. HEARTBEAT (server → client):
 *    - The server periodically sends a ping frame with no parent_id,
 *      containing `data.server_ts` (server timestamp) and `data.seq`
 *      (monotonic sequence number).
 *    - The client tracks the last received heartbeat time. If no heartbeat
 *      arrives within HEARTBEAT_TIMEOUT_MS, the client considers the server
 *      dead and closes the transport, triggering reconnect logic.
 *    - Heartbeat frames are filtered out of consumer-visible streams — the
 *      consumer never sees them.
 *
 * Both ping directions use `call: "ping"` — no prefix:verb semantics.
 * They are distinguished by presence/absence of parent_id:
 *   - Has parent_id → keepalive (client→server, scoped to a stream)
 *   - No parent_id  → heartbeat (server→client, connection-level)
 *
 * All ping frames are built and consumed privately inside the client.
 * The consumer API is unaffected.
 */

import type { Frame } from "muninn-frames-ts";
import { encodeFrame } from "muninn-frames-ts";

import type { Transport } from "./transport.js";
import type { ClientStream } from "./stream.js";

// ---------------------------------------------------------------------------
// Constants — match monk-os-kernel stream constants
// ---------------------------------------------------------------------------

/** How often the client sends keepalive pings (ms). */
export const PING_INTERVAL_MS = 100;

/** If no server heartbeat arrives within this window, the connection is dead (ms). */
export const HEARTBEAT_TIMEOUT_MS = 5000;

/** The call string used for all ping frames. */
export const PING_CALL = "ping";

// ---------------------------------------------------------------------------
// PingManager — owns the keepalive timer and heartbeat watchdog
// ---------------------------------------------------------------------------

/**
 * Manages bidirectional ping lifecycle for a single client connection.
 *
 * Created when the client connects. Starts the keepalive timer immediately.
 * The heartbeat watchdog activates on the first received server heartbeat
 * (so it doesn't fire before the server has had a chance to send one).
 *
 * Lifecycle:
 *   connect → new PingManager() → start()
 *   ...
 *   disconnect → stop()
 */
export class PingManager {
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHeartbeatMs = 0;
  private lastHeartbeatSeq = 0;
  private started = false;

  constructor(
    private readonly transport: Transport,
    private readonly streams: Map<string, ClientStream>,
    private readonly onHeartbeatTimeout: () => void
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Starts the keepalive timer. Called once after transport connects.
   *
   * The keepalive timer fires every PING_INTERVAL_MS and sends one ping
   * frame per active stream, reporting how many frames the consumer has
   * pulled from that stream.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.keepaliveTimer = setInterval(() => {
      this.sendKeepalives();
    }, PING_INTERVAL_MS);
  }

  /**
   * Stops all timers. Called when the client disconnects or closes.
   * Idempotent.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.keepaliveTimer !== undefined) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }

    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Inbound: server heartbeat handling
  // -------------------------------------------------------------------------

  /**
   * Called by the client's receive loop when a ping frame with no parent_id
   * arrives. Updates the last-seen heartbeat state and resets the watchdog
   * timer.
   *
   * Expected data shape: { server_ts: number, seq: number }
   */
  onHeartbeat(frame: Frame): void {
    const serverTs = frame.data["server_ts"];
    const seq = frame.data["seq"];

    if (typeof serverTs === "number") {
      this.lastHeartbeatMs = serverTs;
    }
    if (typeof seq === "number") {
      this.lastHeartbeatSeq = seq;
    }

    // Reset the heartbeat watchdog. If we don't receive another heartbeat
    // within HEARTBEAT_TIMEOUT_MS, the onHeartbeatTimeout callback fires
    // (which typically closes the transport and triggers reconnect).
    this.resetHeartbeatWatchdog();
  }

  /** Last server_ts received from a heartbeat, or 0 if none yet. */
  get serverTimestamp(): number {
    return this.lastHeartbeatMs;
  }

  /** Last seq received from a heartbeat, or 0 if none yet. */
  get serverSeq(): number {
    return this.lastHeartbeatSeq;
  }

  // -------------------------------------------------------------------------
  // Outbound: keepalive pings
  // -------------------------------------------------------------------------

  /**
   * Sends one keepalive ping per active stream.
   *
   * Each ping frame carries:
   *   - call: "ping"
   *   - status: "request"
   *   - parent_id: the stream's original request id (for server correlation)
   *   - data.consumed: number of frames the consumer has pulled from this stream
   *
   * The server matches parent_id to its outbound stream controller and calls
   * onPing(consumed) to update the ack count and potentially resume a paused
   * producer.
   */
  private sendKeepalives(): void {
    for (const [requestId, stream] of this.streams) {
      const ping: Frame = {
        id: crypto.randomUUID(),
        parent_id: requestId,
        created_ms: Date.now(),
        expires_in: 0,
        call: PING_CALL,
        status: "request",
        data: { consumed: stream.consumed }
      };

      try {
        this.transport.send(encodeFrame(ping));
      } catch {
        // Transport may be closing — stop sending keepalives.
        // The receive loop will handle cleanup.
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat watchdog
  // -------------------------------------------------------------------------

  /**
   * Resets (or starts) the heartbeat watchdog timer.
   *
   * If no subsequent heartbeat arrives within HEARTBEAT_TIMEOUT_MS, the
   * onHeartbeatTimeout callback fires. This is typically wired to close
   * the transport and begin reconnection.
   */
  private resetHeartbeatWatchdog(): void {
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
    }

    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      this.onHeartbeatTimeout();
    }, HEARTBEAT_TIMEOUT_MS);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if a frame is a ping frame (either direction). */
export function isPingFrame(frame: Frame): boolean {
  return frame.call === PING_CALL;
}
