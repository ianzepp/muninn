import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Frame } from "muninn-frames-ts";
import { decodeFrame } from "muninn-frames-ts";
import { Client } from "./client.js";
import { PING_CALL, HEARTBEAT_TIMEOUT_MS } from "./ping.js";
import type { Transport, TransportFactory } from "./transport.js";

// ---------------------------------------------------------------------------
// Mock transport (same as client_test.ts — kept inline to avoid coupling)
// ---------------------------------------------------------------------------

class MockTransport implements Transport {
  readonly sent: string[] = [];
  private resolve: ((value: IteratorResult<string>) => void) | undefined;
  private readonly buffer: string[] = [];
  private done = false;

  send(data: string): void {
    this.sent.push(data);
  }

  receive(data: string): void {
    if (this.resolve !== undefined) {
      const r = this.resolve;
      this.resolve = undefined;
      r({ value: data, done: false });
    } else {
      this.buffer.push(data);
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.resolve !== undefined) {
      const r = this.resolve;
      this.resolve = undefined;
      r({ value: undefined as unknown as string, done: true });
    }
  }

  async next(): Promise<IteratorResult<string>> {
    if (this.buffer.length > 0) {
      return { value: this.buffer.shift()!, done: false };
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

function mockFactory(): { transport: MockTransport; factory: TransportFactory } {
  const transport = new MockTransport();
  const factory: TransportFactory = async () => transport;
  return { transport, factory };
}

function respondTo(req: Frame, status: Frame["status"], data: Frame["data"] = {}): string {
  return JSON.stringify({
    id: crypto.randomUUID(),
    parent_id: req.id,
    created_ms: Date.now(),
    expires_in: 0,
    call: req.call,
    status,
    data
  });
}

function makeHeartbeat(seq: number): string {
  return JSON.stringify({
    id: crypto.randomUUID(),
    created_ms: Date.now(),
    expires_in: 0,
    call: PING_CALL,
    status: "item",
    data: { server_ts: Date.now(), seq }
  });
}

describe("Ping", () => {
  // -------------------------------------------------------------------------
  // Keepalive: client → server
  // -------------------------------------------------------------------------

  it("sends keepalive pings for active streams", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    // Open a stream
    const stream = client.call("test:slow");

    // Wait for at least one ping interval (100ms) + margin
    await new Promise((r) => setTimeout(r, 150));

    // Filter sent frames to find keepalive pings
    const pings = transport.sent
      .map((s) => decodeFrame(s))
      .filter((f) => f.call === PING_CALL);

    // Should have sent at least one keepalive ping
    assert.ok(pings.length >= 1, `expected at least 1 ping, got ${pings.length}`);

    // Each keepalive ping should reference the stream's request id
    const ping = pings[0]!;
    assert.equal(ping.parent_id, stream.request.id);
    assert.equal(ping.call, PING_CALL);
    assert.equal(ping.status, "request");

    // Consumer hasn't pulled any frames, so consumed should be 0
    assert.equal(ping.data["consumed"], 0);

    // Close to stop timers
    client.close();
  });

  it("reports consumed count accurately", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const stream = client.call("test:items");

    // Push 3 item frames from the server
    transport.receive(respondTo(stream.request, "item", { n: 1 }));
    transport.receive(respondTo(stream.request, "item", { n: 2 }));
    transport.receive(respondTo(stream.request, "item", { n: 3 }));

    // Consumer pulls 2 frames
    await stream.recv();
    await stream.recv();

    // Wait for a keepalive tick
    await new Promise((r) => setTimeout(r, 150));

    // Find the most recent keepalive ping for this stream
    const pings = transport.sent
      .map((s) => decodeFrame(s))
      .filter((f) => f.call === PING_CALL && f.parent_id === stream.request.id);

    const lastPing = pings[pings.length - 1]!;
    assert.equal(lastPing.data["consumed"], 2);

    client.close();
  });

  it("stops sending keepalive pings after stream closes", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const stream = client.call("test:short");

    // Server sends terminal frame
    transport.receive(respondTo(stream.request, "done"));
    await stream.collect();

    // Clear sent buffer and wait for a ping interval
    transport.sent.length = 0;
    await new Promise((r) => setTimeout(r, 150));

    // No keepalive pings should be sent for the closed stream
    const pings = transport.sent
      .map((s) => decodeFrame(s))
      .filter((f) => f.call === PING_CALL && f.parent_id === stream.request.id);

    assert.equal(pings.length, 0);

    client.close();
  });

  // -------------------------------------------------------------------------
  // Heartbeat: server → client
  // -------------------------------------------------------------------------

  it("filters heartbeat frames from consumer streams", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const stream = client.call("test:echo");

    // Server sends: heartbeat, real item, heartbeat, done
    transport.receive(makeHeartbeat(1));
    transport.receive(respondTo(stream.request, "item", { msg: "hello" }));
    transport.receive(makeHeartbeat(2));
    transport.receive(respondTo(stream.request, "done"));

    // Consumer should only see item + done, never heartbeats
    const frames = await stream.collect();
    assert.equal(frames.length, 2);
    assert.equal(frames[0]!.status, "item");
    assert.equal(frames[1]!.status, "done");

    client.close();
  });

  it("closes transport on heartbeat timeout", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const stream = client.call("test:long");

    // Send one heartbeat to start the watchdog
    transport.receive(makeHeartbeat(1));

    // Wait for the heartbeat timeout to fire
    await new Promise((r) => setTimeout(r, HEARTBEAT_TIMEOUT_MS + 100));

    // Stream should be closed because client killed the connection
    const frame = await stream.recv();
    assert.equal(frame, undefined);

    client.close();
  });

  it("resets heartbeat watchdog on each heartbeat", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const stream = client.call("test:long");

    // Send heartbeats every 2s — well within the 5s timeout
    transport.receive(makeHeartbeat(1));
    await new Promise((r) => setTimeout(r, 2000));
    transport.receive(makeHeartbeat(2));
    await new Promise((r) => setTimeout(r, 2000));
    transport.receive(makeHeartbeat(3));

    // Stream should still be alive — watchdog was reset each time
    transport.receive(respondTo(stream.request, "done", { alive: true }));

    const frames = await stream.collect();
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.status, "done");

    client.close();
  });
});
