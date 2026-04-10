import test from "node:test";
import assert from "node:assert/strict";

import { Kernel, SigcallError, frame, request } from "./index.js";

test("sigcall routes to registered external handler", async () => {
  const kernel = Kernel.create();
  const handler = kernel.sigcalls().register("custom:op", "plugin-1");

  const collectPromise = kernel.caller().collect(request("custom:op").frame);
  const inbound = await handler.recv();

  assert.ok(inbound);
  await handler.send(frame(inbound).done({ ok: true }));

  const frames = await collectPromise;
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.status, "done");
  assert.deepEqual(frames[0]?.data, { ok: true });
});

test("sigcall:list returns registered handlers", async () => {
  const kernel = Kernel.create();
  kernel.sigcalls().register("custom:a", "owner-1");
  kernel.sigcalls().register("custom:b", "owner-2");

  const frames = await kernel.caller().collect(request("sigcall:list").frame);

  const items = frames.filter((frameValue) => frameValue.status === "item");
  const terminal = frames.at(-1);

  assert.equal(items.length, 2);
  assert.equal(terminal?.status, "done");
});

test("sigcall registry enforces ownership and reserved names", () => {
  const kernel = Kernel.create();
  kernel.sigcalls().register("custom:a", "owner-1");

  assert.throws(
    () => kernel.sigcalls().register("custom:a", "owner-2"),
    SigcallError
  );
  assert.throws(
    () => kernel.sigcalls().register("sigcall:register", "owner-1"),
    SigcallError
  );
});

test("same-owner sigcall re-register reuses the existing endpoint", async () => {
  const kernel = Kernel.create();
  const first = kernel.sigcalls().register("custom:reconnect", "owner-1");
  const second = kernel.sigcalls().register("custom:reconnect", "owner-1");

  assert.equal(first, second);

  const collectPromise = kernel.caller().collect(request("custom:reconnect").frame);
  const inbound = await first.recv();

  assert.ok(inbound);
  await first.send(frame(inbound).done({ ok: true }));

  const frames = await collectPromise;
  assert.equal(frames.at(-1)?.status, "done");
});
