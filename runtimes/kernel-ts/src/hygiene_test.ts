// Hygiene — enforces coding standards at test time.
//
// These tests scan the source tree for antipatterns that violate project
// standards. Each has a budget (ideally zero). If you must add one, you
// have to fix an existing one first — the budget never grows.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Ratchet budgets: these reflect current production-code totals.
// Lower them as existing debt is removed; no category may grow.

// Type system escapes.
const MAX_ANY_TYPE = 0;
const MAX_AS_UNKNOWN_AS = 0;
const MAX_TS_SUPPRESS = 0;         // @ts-ignore, @ts-expect-error, @ts-nocheck

// Crash / unhandled paths.
const MAX_THROW_NEW_ERROR = 0;     // use typed error factories (KernelError, SigcallError)

// Silent promise loss — fire-and-forget void discards.
const MAX_VOID_DISPATCH = 3;       // kernel.ts:runSyscall, caller.ts:dispatch x2

// Serialization inside the kernel boundary.
// JSON.stringify in error message strings (errors.ts) is allowed; the budget
// here counts only the uses in non-errors files.
const MAX_JSON_STRINGIFY_NON_ERRORS = 0;
const MAX_JSON_PARSE = 0;

// Debug / observability leaks.
const MAX_CONSOLE = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

interface SourceFile {
  filePath: string;
  content: string;
  lines: string[];
}

function collectSourceFiles(dir: string): SourceFile[] {
  const results: SourceFile[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_test.ts")
    ) {
      const content = fs.readFileSync(fullPath, "utf8");
      results.push({ filePath: fullPath, content, lines: content.split("\n") });
    }
  }

  return results;
}

function countMatches(files: SourceFile[], pattern: string): number {
  let total = 0;
  for (const file of files) {
    for (const line of file.lines) {
      if (line.includes(pattern)) total++;
    }
  }
  return total;
}

function countMatchesExcluding(
  files: SourceFile[],
  pattern: string,
  excludePath: string
): number {
  let total = 0;
  for (const file of files) {
    if (file.filePath.includes(excludePath)) continue;
    for (const line of file.lines) {
      if (line.includes(pattern)) total++;
    }
  }
  return total;
}

const srcDir = path.resolve(import.meta.dirname ?? ".", "..", "src");
const files = collectSourceFiles(srcDir);

// ── Type system escapes ──────────────────────────────────────────────────────

describe("hygiene", () => {
  it("any type budget", () => {
    const count = countMatches(files, ": any");
    assert.ok(
      count <= MAX_ANY_TYPE,
      `": any" budget exceeded: found ${count}, max ${MAX_ANY_TYPE}.`
    );
  });

  it("as unknown as budget", () => {
    const count = countMatches(files, "as unknown as");
    assert.ok(
      count <= MAX_AS_UNKNOWN_AS,
      `"as unknown as" budget exceeded: found ${count}, max ${MAX_AS_UNKNOWN_AS}.`
    );
  });

  it("ts-suppress budget", () => {
    const count = countMatches(files, "@ts-");
    assert.ok(
      count <= MAX_TS_SUPPRESS,
      `"@ts-" suppress comment budget exceeded: found ${count}, max ${MAX_TS_SUPPRESS}.`
    );
  });

  // ── Crash / unhandled paths ────────────────────────────────────────────────

  it("throw new Error budget", () => {
    const count = countMatches(files, "throw new Error");
    assert.ok(
      count <= MAX_THROW_NEW_ERROR,
      `"throw new Error" budget exceeded: found ${count}, max ${MAX_THROW_NEW_ERROR}. Use KernelError or SigcallError factories instead.`
    );
  });

  // ── Silent promise loss ────────────────────────────────────────────────────

  it("void dispatch budget", () => {
    const count = countMatches(files, "void ");
    // Exclude return type annotations (": void") and parameter types ("=> void")
    let fireAndForget = 0;
    for (const file of files) {
      for (const line of file.lines) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("void ") && !trimmed.startsWith("void 0")) {
          fireAndForget++;
        }
      }
    }
    assert.ok(
      fireAndForget <= MAX_VOID_DISPATCH,
      `fire-and-forget "void <expr>" budget exceeded: found ${fireAndForget}, max ${MAX_VOID_DISPATCH}.`
    );
  });

  // ── Serialization inside kernel boundary ──────────────────────────────────

  it("JSON.stringify outside errors.ts budget", () => {
    const count = countMatchesExcluding(files, "JSON.stringify", "errors.ts");
    assert.ok(
      count <= MAX_JSON_STRINGIFY_NON_ERRORS,
      `JSON.stringify budget exceeded: found ${count}, max ${MAX_JSON_STRINGIFY_NON_ERRORS}. Serialization belongs at transport boundaries, not inside the kernel.`
    );
  });

  it("JSON.parse budget", () => {
    const count = countMatches(files, "JSON.parse");
    assert.ok(
      count <= MAX_JSON_PARSE,
      `JSON.parse budget exceeded: found ${count}, max ${MAX_JSON_PARSE}. Deserialization belongs at transport boundaries.`
    );
  });

  // ── Debug leaks ───────────────────────────────────────────────────────────

  it("console budget", () => {
    const count = countMatches(files, "console.");
    assert.ok(
      count <= MAX_CONSOLE,
      `console.* budget exceeded: found ${count}, max ${MAX_CONSOLE}.`
    );
  });
});
