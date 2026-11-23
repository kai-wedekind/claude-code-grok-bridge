/**
 * `check --verify-tools` starts a real model session through runGrok and bounds it with
 * timeoutMs (grok-bridge.mjs). The bound has to reach runCommand, or a wedged CLI hangs `check`
 * with no output.
 *
 * runGrok blocks in spawnSync, which a node:test timeout cannot interrupt, so the call runs in
 * a child process with an outer bound: a regression fails this test instead of hanging the suite.
 */
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GROK_LIB = pathToFileURL(path.join(ROOT, "plugins", "grok-build", "scripts", "lib", "grok.mjs")).href;

test("runGrok passes timeoutMs on, so a hanging session is ended", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "hang");
  const child = [
    `const { runGrok } = await import(${JSON.stringify(GROK_LIB)});`,
    `const r = runGrok(["-p", "say ok", "--output-format", "json"], { cwd: ${JSON.stringify(binDir)}, timeoutMs: 1500 });`,
    `process.stdout.write(JSON.stringify({ status: r.status, signal: r.signal, error: r.error?.code ?? null }));`
  ].join("\n");
  const started = Date.now();
  const result = run(process.execPath, ["--input-type=module", "-e", child], {
    cwd: binDir,
    env: buildEnv(binDir),
    timeout: 30000
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 25000, `runGrok returned after ${elapsed} ms; the bound did not reach the CLI`);
  assert.equal(result.status, 0, result.stderr);
  const inner = JSON.parse(result.stdout);
  assert.notEqual(inner.status, 0, result.stdout);
});
