/**
 * A job's log path is derived, never taken from the record.
 *
 * `job.logFile` comes back out of `state.json`, and state.json is not always somewhere only
 * we can write: with `CLAUDE_PLUGIN_DATA` unset the state root is
 * `os.tmpdir()/grok-cc-runs-<user>`, whose parent is world-writable on Linux and macOS. A
 * local attacker who creates that directory before the first run owns its contents, and
 * every consumer of the stored path becomes a primitive — one appends to it, one reads it,
 * one deletes it.
 *
 * The deletion path was contained on 2026-07-31 by comparing against the state directory.
 * The audit that was asked what a hostile local user could do then pointed out the obvious:
 * the same value is still trusted everywhere else. This pins the better shape — do not
 * validate the attacker's value, do not use it at all — for the paths that write and read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { resolveTrustedJobLogFile, resolveJobLogFile } from "../plugins/grok-build/scripts/lib/state.mjs";

function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("a poisoned logFile on the record is ignored, not sanitised", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const elsewhere = path.join(os.tmpdir(), "grok-cc-victim-target.txt");

    const resolved = resolveTrustedJobLogFile({
      id: "run-abc123",
      workspaceRoot: workspace,
      // What an attacker who owns the state directory would write there.
      logFile: elsewhere
    });

    assert.notEqual(resolved, elsewhere, "the stored path must not be honoured");
    assert.equal(
      resolved,
      resolveJobLogFile(workspace, "run-abc123"),
      "the path must follow from workspace and id, which are both validated"
    );
    assert.ok(!fs.existsSync(elsewhere), "nothing may be created at the attacker's path");
  });
});

test("a record that cannot say where it belongs yields no log path at all", () => {
  withPluginData(() => {
    const elsewhere = path.join(os.tmpdir(), "grok-cc-victim-target-2.txt");

    // Missing workspaceRoot — the tempting fallback is exactly the stored value, and that
    // is the one thing it must not be. Every caller treats null as "no log".
    assert.equal(resolveTrustedJobLogFile({ id: "run-abc123", logFile: elsewhere }), null);
    // Missing id.
    assert.equal(resolveTrustedJobLogFile({ workspaceRoot: makeTempDir(), logFile: elsewhere }), null);
    // An id that would escape the jobs directory is rejected by assertValidJobId, and the
    // helper turns that into null rather than letting it throw at a call site whose only
    // job was to write a log line.
    assert.equal(
      resolveTrustedJobLogFile({ id: "../../escape", workspaceRoot: makeTempDir(), logFile: elsewhere }),
      null
    );
    assert.equal(resolveTrustedJobLogFile(null), null);
  });
});

/**
 * Every remaining read of a stored log path, enumerated.
 *
 * The first version of this test named two files and asserted the string was absent from
 * them. Both were clean, the suite was green, and nine untouched sites in a third file plus
 * four more across two others still wrote to the attacker-controlled path — including every
 * error path in `runTrackedJob`, which is the code that runs precisely when something has
 * gone wrong. Grok's verification of the fix found them (2026-07-31).
 *
 * So the shape is inverted: scan the whole tree, and require every occurrence to be one this
 * list already knows about. A new consumer fails until somebody writes down why it is
 * allowed — which is the question the two-file version never asked.
 */
const ALLOWED_RECORD_READS = new Map([
  // Contained by comparison against the state directory, and deleting is the one operation
  // where the stored value is still the right question to ask: it names what THIS record
  // created. removeFileIfExists refuses anything outside.
  ["lib/state.mjs::removeFileIfExists(job.logFile, resolveStateDir(cwd));", "contained delete"],
  // Persistence into the index. No I/O follows from these; they carry the value that
  // render.mjs displays.
  ["lib/state.mjs::logFile: nextJob.logFile ?? existing.logFile ?? null,", "index persistence"],
  ["lib/state.mjs::logFile: nextJob.logFile,", "index persistence"],
  ["lib/state.mjs::logFile: fileJob.logFile ?? current.logFile ?? null,", "index persistence"],
  // Display. Printing a string is not opening it.
  ["lib/render.mjs::if (job.logFile && options.showLog) {", "display only"],
  ["lib/render.mjs::lines.push(`  Log: ${job.logFile}`);", "display only"]
]);

function collectSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(full, out);
    } else if (entry.name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

test("every read of a stored log path is one this test knows about", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scriptsRoot = path.join(root, "plugins/grok-build/scripts");
  const offenders = [];

  for (const file of collectSources(scriptsRoot)) {
    const relative = path.relative(scriptsRoot, file).split(path.sep).join("/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        return;
      }
      // `options.logFile` is an argument a caller passed in, not a value off the disk.
      const reads = [...trimmed.matchAll(/([A-Za-z_$][\w$]*)\.logFile\b/g)]
        .filter((match) => match[1] !== "options");
      if (reads.length === 0) {
        return;
      }
      if (!ALLOWED_RECORD_READS.has(`${relative}::${trimmed}`)) {
        offenders.push(`${relative}:${index + 1}  ${trimmed}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `these read a log path off the record; derive it with resolveTrustedJobLogFile instead, ` +
      `or add it to ALLOWED_RECORD_READS with a reason:\n${offenders.join("\n")}`
  );
});
