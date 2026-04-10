/**
 * SigcallRegistry — runtime dynamic handler registration.
 *
 * The `SigcallRegistry` extends the kernel's static syscall routing with a
 * mutable, ownership-enforced map of call names to pipe endpoints. Unlike
 * syscalls (registered once at startup), sigcalls can be added and removed
 * at runtime — making them suitable for plugin systems, hot-reloadable
 * services, or any scenario where the handler set is not known at construction
 * time.
 *
 * Ownership model:
 * - Each registration carries an opaque `owner` string.
 * - A second attempt to register the same name from a different owner is
 *   rejected with `SigcallError.alreadyRegistered`.
 * - The same owner may re-register the same name and will receive the
 *   existing `PipeEnd` back (idempotent re-registration).
 * - Only the registering owner may unregister a name.
 *
 * The `sigcall:` prefix namespace is reserved; attempting to register a name
 * that starts with it throws `SigcallError.reserved`.
 *
 * Routing:
 * The kernel calls `lookup(call)` during request routing. If a queue is
 * returned, the request is pushed directly onto it — the sigcall handler
 * owns the same pipe-based protocol as a regular `PipeEnd`.
 */

import type { Frame } from "muninn-frames-ts";

import { PipeEnd } from "./pipe.js";
import { AsyncQueue } from "./queue.js";
import { SigcallError } from "./errors.js";
import type { Kernel } from "./kernel.js";

interface Registration {
  owner: string;
  queue: AsyncQueue<Frame>;
  pipe: PipeEnd;
}

/**
 * Mutable registry mapping call names to owner-guarded pipe endpoints.
 *
 * Obtained via `Kernel.sigcalls()`. All mutating operations enforce ownership
 * to prevent one module from hijacking or deleting another's handler.
 */
export class SigcallRegistry {
  private readonly registrations = new Map<string, Registration>();

  constructor(private readonly kernel: Kernel) {}

  /**
   * Registers a call name and returns its `PipeEnd`.
   *
   * If the name is already registered by the same `owner`, the existing
   * `PipeEnd` is returned (idempotent). If it is registered by a different
   * owner, `SigcallError.alreadyRegistered` is thrown.
   *
   * @param name - The full call string to handle (e.g. `"plugin:process"`).
   * @param owner - An opaque identifier for the registering module or component.
   * @returns The `PipeEnd` through which the handler receives inbound frames.
   * @throws `SigcallError` if the name starts with `"sigcall:"` or is owned by another.
   */
  register(name: string, owner: string): PipeEnd {
    if (name.startsWith("sigcall:")) {
      throw SigcallError.reserved(name);
    }

    const existing = this.registrations.get(name);
    if (existing !== undefined) {
      if (existing.owner !== owner) {
        throw SigcallError.alreadyRegistered(name, existing.owner);
      }

      return existing.pipe;
    }

    const queue = new AsyncQueue<Frame>();
    const pipe = new PipeEnd(this.kernel, queue);
    this.registrations.set(name, { owner, queue, pipe });
    return pipe;
  }

  /**
   * Removes the registration for `name` and closes its inbound queue,
   * signalling the handler that no further frames will arrive.
   *
   * @param name - The call name to unregister.
   * @param owner - Must match the owner that originally registered the name.
   * @throws `SigcallError` if the name is not registered or `owner` does not match.
   */
  unregister(name: string, owner: string): void {
    const existing = this.registrations.get(name);
    if (existing === undefined) {
      throw SigcallError.notRegistered(name);
    }

    if (existing.owner !== owner) {
      throw SigcallError.notOwner(name, existing.owner, owner);
    }

    existing.queue.close();
    this.registrations.delete(name);
  }

  /**
   * Removes all registrations belonging to `owner` and closes their queues.
   *
   * Useful for clean module teardown — a plugin can call `unregisterAll` with
   * its own identifier to release all handlers it holds without tracking each
   * name individually.
   *
   * @param owner - The owner whose registrations should be removed.
   */
  unregisterAll(owner: string): void {
    for (const [name, registration] of this.registrations) {
      if (registration.owner === owner) {
        registration.queue.close();
        this.registrations.delete(name);
      }
    }
  }

  /**
   * Returns the inbound queue for a registered call name, or `undefined` if
   * no handler is registered. Used by the kernel's routing path to push
   * inbound request frames to the correct handler.
   *
   * @param name - The full call string to look up.
   */
  lookup(name: string): AsyncQueue<Frame> | undefined {
    return this.registrations.get(name)?.queue;
  }

  /**
   * Returns a snapshot of all active registrations as plain objects.
   * Used by the kernel to serve `sigcall:list` requests.
   */
  list(): Array<{ name: string; owner: string }> {
    return [...this.registrations.entries()].map(([name, registration]) => ({
      name,
      owner: registration.owner
    }));
  }

  len(): number {
    return this.registrations.size;
  }

  isEmpty(): boolean {
    return this.registrations.size === 0;
  }
}
