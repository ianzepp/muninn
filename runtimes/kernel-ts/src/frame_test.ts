import test from "node:test";
import assert from "node:assert/strict";

import { frame, makeFrame, request } from "./index.js";

test("frame builder preserves correlation and trace", () => {
  const req = frame(request("echo:ping").frame).withTrace({ span: "abc" });
  const item = frame(req).item({ ok: true });

  assert.equal(item.parent_id, req.id);
  assert.equal(item.call, "echo:ping");
  assert.deepEqual(item.trace, { span: "abc" });
  assert.equal(item.status, "item");
});

test("makeFrame builds validated explicit frames", () => {
  const explicit = makeFrame({
    id: "frame-1",
    parent_id: "parent-1",
    created_ms: 1,
    expires_in: 0,
    call: "echo:ping",
    status: "item",
    data: { ok: true }
  });

  assert.equal(explicit.id, "frame-1");
  assert.equal(explicit.parent_id, "parent-1");
});
