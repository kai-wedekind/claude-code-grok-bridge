/**
 * A failed run keeps its warnings on stdout: both failure returns of renderTaskResult carry
 * them, so the connector "session history was not checked" sentence reaches a caller reading
 * the rendered output — the delegate does — and not only `--json`.
 */
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { renderTaskResult } from "../plugins/grok-build/scripts/lib/render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

test("a connector run that runs out of turns says on stdout that its history was not checked", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "max-turns");
  const result = run(
    process.execPath,
    [SCRIPT, "run", "--connector", "google_calendar", "--max-turns", "2", "--cwd", makeTempDir(), "look it up"],
    { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() }) }
  );

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /ran out of turns before finishing/);
  assert.match(result.stdout, /session history was not checked/);
  // The cause stays on line one; the warning comes after it.
  assert.match(result.stdout.split("\n")[0], /Run did not succeed/);
});

test("a warning the failure text already carries is printed once", () => {
  const sentence = "Automatic retry skipped: Grok Build was disabled during the run (flag file appeared).";
  const output = renderTaskResult(
    {
      rawOutput: "",
      failureMessage: `Grok returned no output. ${sentence}`,
      warnings: [sentence, "Read-only: tool removal and deny rules confine this run."]
    },
    { failureCode: "no-deliverable" }
  );

  assert.equal(output.split(sentence).length - 1, 1, output);
  assert.match(output, /\[grok-cc\] Warning: Read-only: tool removal/);
});

test("a successful run's output is unchanged: warnings after the body, no failure line", () => {
  const output = renderTaskResult(
    { rawOutput: "The answer.", warnings: ["Thread registration failed."] },
    { failureCode: null }
  );

  assert.equal(output, "The answer.\n\n[grok-cc] Warning: Thread registration failed.\n");
});
