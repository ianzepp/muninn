import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import type { Frame } from "muninn-frames-ts";

import {
  Caller,
  Kernel,
  type Syscall,
  frame,
  request,
  verbOf
} from "./index.js";

class EchoSyscall implements Syscall {
  prefix(): string {
    return "echo";
  }

  async *dispatch(frameValue: Frame): AsyncIterable<Frame> {
    yield frame(frameValue).item({ verb: verbOf(frameValue.call) });
    yield frame(frameValue).done({ ok: true });
  }
}

class SlowSyscall implements Syscall {
  prefix(): string {
    return "slow";
  }

  async *dispatch(frameValue: Frame, _caller: Caller, cancel: AbortSignal): AsyncIterable<Frame> {
    await delay(50);

    if (cancel.aborted) {
      return;
    }

    yield frame(frameValue).item({ step: 1 });
    await delay(200);

    if (cancel.aborted) {
      return;
    }

    yield frame(frameValue).done({ ok: true });
  }
}

test("caller collects streamed syscall responses", async () => {
  const kernel = Kernel.create();
  kernel.register(new EchoSyscall());

  const frames = await kernel.caller().collect(request("echo:ping").frame);

  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.status, "item");
  assert.deepEqual(frames[0]?.data, { verb: "ping" });
  assert.equal(frames[1]?.status, "done");
  assert.deepEqual(frames[1]?.data, { ok: true });
});

test("unknown routes return a terminal error frame", async () => {
  const kernel = Kernel.create();

  const frames = await kernel.caller().collect(request("missing:verb").frame);
  const terminal = frames.at(-1);

  assert.equal(terminal?.status, "error");
  assert.equal(terminal?.data.code, "E_NO_ROUTE");
});

test("subscriber sees outbound responses", async () => {
  const kernel = Kernel.create();
  kernel.register(new EchoSyscall());

  const subscriber = kernel.subscribe();
  const callPromise = kernel.caller().collect(request("echo:stream").frame);

  const seen = await subscriber.collect({
    until: (frameValue: Frame) => frameValue.status === "done"
  });

  await callPromise;

  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.status, "item");
  assert.equal(seen[1]?.status, "done");
});

test("abort signal emits cancel terminal frame", async () => {
  const kernel = Kernel.create();
  kernel.register(new SlowSyscall());

  const controller = new AbortController();
  const collectPromise = kernel.caller().collect(
    request("slow:work").frame,
    { signal: controller.signal }
  );

  await delay(75);
  controller.abort();

  const frames = await collectPromise;
  const terminal = frames.at(-1);

  assert.equal(frames[0]?.status, "item");
  assert.equal(terminal?.status, "cancel");
});

test("raw prefix registration can receive requests and send responses", async () => {
  const kernel = Kernel.create();
  const pipe = kernel.registerPrefix("pipe");

  const collectPromise = kernel.caller().collect(request("pipe:work").frame);
  const inbound = await pipe.recv();
  assert.ok(inbound);

  await pipe.send(frame(inbound).done({ handled: true }));

  const frames = await collectPromise;
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.status, "done");
  assert.deepEqual(frames[0]?.data, { handled: true });
});
