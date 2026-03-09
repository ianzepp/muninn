import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Frame } from "muninn-frames-ts";
import { decodeFrame } from "muninn-frames-ts";
import { Client } from "./client.js";
import type { Transport, TransportFactory } from "./transport.js";

// ---------------------------------------------------------------------------
// Mock transport — in-memory, no real network
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

/** Decode the last sent frame from the transport. */
function lastSent(transport: MockTransport): Frame {
  return decodeFrame(transport.sent[transport.sent.length - 1]!);
}

describe("Client", () => {
  it("sends request and receives responses", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const stream = client.call("test:echo", { msg: "hello" });

    // Verify the request was sent
    assert.equal(transport.sent.length, 1);
    const sent = decodeFrame(transport.sent[0]!);
    assert.equal(sent.call, "test:echo");
    assert.equal(sent.status, "request");

    // Simulate server responses using the request from the stream
    transport.receive(respondTo(stream.request, "item", { msg: "world" }));
    transport.receive(respondTo(stream.request, "done"));

    const frames = await stream.collect();
    assert.equal(frames.length, 2);
    assert.equal(frames[0]!.status, "item");
    assert.deepEqual(frames[0]!.data, { msg: "world" });
    assert.equal(frames[1]!.status, "done");

    client.close();
  });

  it("collect() convenience works", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const collectPromise = client.collect("test:ping");

    // Get the request that was sent so we can respond to it
    const req = lastSent(transport);
    transport.receive(respondTo(req, "done", { pong: true }));

    const frames = await collectPromise;
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.status, "done");

    client.close();
  });

  it("first() convenience returns first frame then closes", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const firstPromise = client.first("test:info");

    const req = lastSent(transport);
    transport.receive(respondTo(req, "item", { version: "1.0" }));

    const frame = await firstPromise;
    assert.equal(frame?.status, "item");
    assert.deepEqual(frame?.data, { version: "1.0" });

    client.close();
  });

  it("closes pending streams when transport disconnects", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const stream = client.call("test:long");

    transport.close();
    await new Promise((r) => setTimeout(r, 10));

    const frame = await stream.recv();
    assert.equal(frame, undefined);

    client.close();
  });

  it("ignores frames with no parent_id", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const stream = client.call("test:echo");

    // Send a frame without parent_id (should be ignored)
    transport.receive(JSON.stringify({
      id: crypto.randomUUID(),
      created_ms: Date.now(),
      expires_in: 0,
      call: "test:echo",
      status: "item",
      data: { stray: true }
    }));

    // Now send the real response
    transport.receive(respondTo(stream.request, "done"));

    const frames = await stream.collect();
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.status, "done");

    client.close();
  });

  it("sends cancel frame when abort signal fires", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const controller = new AbortController();
    const stream = client.call("test:slow", {}, { signal: controller.signal });

    controller.abort();

    // Should have sent: request + cancel
    assert.equal(transport.sent.length, 2);
    const cancel = decodeFrame(transport.sent[1]!);
    assert.equal(cancel.status, "cancel");
    assert.equal(cancel.parent_id, stream.request.id);

    client.close();
  });

  it("handles multiple concurrent streams", async () => {
    const { transport, factory } = mockFactory();
    const client = await Client.connect("ws://test", { transport: factory });

    const stream1 = client.call("test:a");
    const stream2 = client.call("test:b");

    // Respond to stream2 first, then stream1
    transport.receive(respondTo(stream2.request, "done", { who: "b" }));
    transport.receive(respondTo(stream1.request, "done", { who: "a" }));

    const [frames1, frames2] = await Promise.all([
      stream1.collect(),
      stream2.collect()
    ]);

    assert.equal(frames1.length, 1);
    assert.deepEqual(frames1[0]!.data, { who: "a" });
    assert.equal(frames2.length, 1);
    assert.deepEqual(frames2[0]!.data, { who: "b" });

    client.close();
  });
});
