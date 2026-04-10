import test from "node:test";
import assert from "node:assert/strict";

import type { Frame } from "muninn-frames-ts";

import { KernelError } from "./errors.js";
import { normalizeResponse } from "./normalize.js";
import { request } from "./frame.js";

test("normalizeResponse fills parent_id, call, and trace from request", () => {
  const req = request("echo:ping", { input: true }).withTrace({ span: "abc" });
  const response: Frame = {
    id: "resp-1",
    created_ms: 2,
    expires_in: 0,
    call: "",
    status: "done",
    data: { ok: true }
  };

  const normalized = normalizeResponse(req, response);

  assert.equal(normalized.parent_id, req.id);
  assert.equal(normalized.call, req.call);
  assert.deepEqual(normalized.trace, { span: "abc" });
});

test("normalizeResponse preserves explicit parent_id and call", () => {
  const req = request("echo:ping").frame;
  const response: Frame = {
    id: "resp-2",
    parent_id: "custom-parent",
    created_ms: 2,
    expires_in: 0,
    call: "other:verb",
    status: "item",
    data: { ok: true }
  };

  const normalized = normalizeResponse(req, response);

  assert.equal(normalized.parent_id, "custom-parent");
  assert.equal(normalized.call, "other:verb");
});

test("normalizeResponse rejects request-status responses", () => {
  const req = request("echo:ping").frame;
  const response: Frame = {
    id: "resp-3",
    created_ms: 2,
    expires_in: 0,
    call: "echo:ping",
    status: "request",
    data: {}
  };

  assert.throws(
    () => normalizeResponse(req, response),
    (error: unknown) =>
      error instanceof KernelError &&
      error.code === "E_INTERNAL" &&
      error.message === "syscall yielded request status"
  );
});
