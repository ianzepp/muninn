import assert from "node:assert/strict";
import test from "node:test";

import {
  FrameValidationError,
  decodeFrame,
  encodeFrame,
  isStatus,
  isTerminalStatus,
  type Frame
} from "./index.js";

function sampleFrame(): Frame {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    parent_id: "550e8400-e29b-41d4-a716-446655440001",
    created_ms: 42,
    expires_in: 0,
    from: "user-1",
    call: "object:update",
    status: "done",
    trace: {
      room: "alpha"
    },
    data: {
      x: 1.25,
      ok: true
    }
  };
}

test("status guards align with lifecycle semantics", () => {
  assert.equal(isStatus("request"), true);
  assert.equal(isStatus("invalid"), false);
  assert.equal(isTerminalStatus("done"), true);
  assert.equal(isTerminalStatus("error"), true);
  assert.equal(isTerminalStatus("request"), false);
});

test("encode/decode round trip preserves frame fields", () => {
  const frame = sampleFrame();
  const encoded = encodeFrame(frame);
  const decoded = decodeFrame(encoded);

  assert.equal(decoded.id, frame.id);
  assert.equal(decoded.call, frame.call);
  assert.equal(decoded.status, frame.status);
  assert.deepEqual(decoded.data, frame.data);
});

test("decode defaults missing data to empty object", () => {
  const decoded = decodeFrame(
    JSON.stringify({
      id: "id-1",
      created_ms: 1,
      expires_in: 0,
      call: "board:list",
      status: "request"
    })
  );

  assert.deepEqual(decoded.data, {});
});

test("decode rejects invalid statuses", () => {
  assert.throws(
    () =>
      decodeFrame(
        JSON.stringify({
          id: "id-1",
          created_ms: 1,
          expires_in: 0,
          call: "board:list",
          status: "invalid",
          data: {}
        })
      ),
    FrameValidationError
  );
});

test("encode rejects missing data", () => {
  assert.throws(
    () =>
      encodeFrame({
        ...sampleFrame(),
        data: undefined as unknown as Frame["data"]
      }),
    FrameValidationError
  );
});

test("encode rejects scalar data payloads", () => {
  assert.throws(
    () =>
      encodeFrame({
        ...sampleFrame(),
        data: 24 as unknown as Frame["data"]
      }),
    FrameValidationError
  );
});

test("decode rejects array data payloads", () => {
  assert.throws(
    () =>
      decodeFrame(
        JSON.stringify({
          id: "id-1",
          created_ms: 1,
          expires_in: 0,
          call: "board:list",
          status: "request",
          data: [1, 2, 3]
        })
      ),
    FrameValidationError
  );
});
