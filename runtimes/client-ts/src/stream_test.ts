import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Frame } from "muninn-frames-ts";
import { ClientStream } from "./stream.js";

function makeRequest(): Frame {
  return {
    id: crypto.randomUUID(),
    created_ms: Date.now(),
    expires_in: 0,
    call: "test:echo",
    status: "request",
    data: {}
  };
}

function makeResponse(request: Frame, status: Frame["status"], data: Frame["data"] = {}): Frame {
  return {
    id: crypto.randomUUID(),
    parent_id: request.id,
    created_ms: Date.now(),
    expires_in: 0,
    call: request.call,
    status,
    data
  };
}

describe("ClientStream", () => {
  it("delivers frames via async iteration", async () => {
    const req = makeRequest();
    const stream = new ClientStream(req);

    stream._push(makeResponse(req, "item", { n: 1 }));
    stream._push(makeResponse(req, "item", { n: 2 }));
    stream._push(makeResponse(req, "done"));

    const frames = await stream.collect();
    assert.equal(frames.length, 3);
    assert.equal(frames[0]!.status, "item");
    assert.equal(frames[1]!.status, "item");
    assert.equal(frames[2]!.status, "done");
  });

  it("closes automatically on terminal frame", async () => {
    const req = makeRequest();
    const stream = new ClientStream(req);

    stream._push(makeResponse(req, "error", { code: "E_NOT_FOUND", message: "gone", retryable: false }));

    const frame = await stream.recv();
    assert.equal(frame?.status, "error");

    const next = await stream.recv();
    assert.equal(next, undefined);
  });

  it("close() terminates the stream early", async () => {
    const req = makeRequest();
    const stream = new ClientStream(req);

    stream._push(makeResponse(req, "item", { n: 1 }));
    stream.close();

    // Should get the buffered item, then done
    const first = await stream.recv();
    assert.equal(first?.status, "item");

    const second = await stream.recv();
    assert.equal(second, undefined);
  });

  it("ignores pushes after close", async () => {
    const req = makeRequest();
    const stream = new ClientStream(req);

    stream.close();
    stream._push(makeResponse(req, "item", { n: 1 }));

    const frame = await stream.recv();
    assert.equal(frame, undefined);
  });

  it("collect stops at terminal frame", async () => {
    const req = makeRequest();
    const stream = new ClientStream(req);

    stream._push(makeResponse(req, "bulk", { rows: [1, 2, 3] }));
    stream._push(makeResponse(req, "done"));

    const frames = await stream.collect();
    assert.equal(frames.length, 2);
    assert.equal(frames[1]!.status, "done");
  });
});
