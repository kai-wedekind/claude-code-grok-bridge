// `Number(timeout) || 240000` made `--timeout-ms 0` and a non-numeric value wait four
// minutes. Missing stays the default; 0 checks once; a negative or non-finite value
// names the flag and fails (upstream #57, 2026-10-24).
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");
const DEFAULT_WAIT_MS = 240000;

function seedCompleted(workspace, pluginDataDir, id) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const job = {
      id,
      status: "completed",
      phase: "done",
      jobClass: "task",
      title: "wait timeout",
      summary: "finished",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logFile: null
    };
    writeJobFile(workspace, id, job);
    upsertJob(workspace, job);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function waitRun(workspace, pluginDataDir, binDir, extraArgs) {
  return run(process.execPath, [SCRIPT, "runs", "job-wait", "--wait", "--json", "--cwd", workspace, ...extraArgs], {
    cwd: workspace,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
  });
}

function prepare() {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  seedCompleted(workspace, pluginDataDir, "job-wait");
  return { workspace, pluginDataDir, binDir };
}

test("runs --wait with no --timeout-ms keeps the four-minute default", () => {
  const { workspace, pluginDataDir, binDir } = prepare();
  const started = Date.now();
  const result = waitRun(workspace, pluginDataDir, binDir, []);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.timeoutMs, DEFAULT_WAIT_MS);
  assert.equal(payload.waitTimedOut, false);
  assert.ok(Date.now() - started < 5000, "a finished run must not sit out the default");
});

test("runs --wait --timeout-ms 0 checks once instead of using the four-minute default", () => {
  const { workspace, pluginDataDir, binDir } = prepare();
  const started = Date.now();
  // 50 is under the poll floor and must stay legal. The floor raises it; it is not an error.
  const result = waitRun(workspace, pluginDataDir, binDir, ["--timeout-ms", "0", "--poll-interval-ms", "50"]);
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.timeoutMs, 0);
  assert.equal(payload.waitTimedOut, false);
  assert.ok(elapsed < 5000, `--timeout-ms 0 took ${elapsed}ms`);
});

test("runs --wait rejects a negative --timeout-ms and names the flag", () => {
  const { workspace, pluginDataDir, binDir } = prepare();
  const result = waitRun(workspace, pluginDataDir, binDir, ["--timeout-ms", "-1"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}`, /--timeout-ms must be a non-negative number of milliseconds/);
});

test("runs --wait rejects a non-numeric --timeout-ms and names the flag", () => {
  const { workspace, pluginDataDir, binDir } = prepare();
  const result = waitRun(workspace, pluginDataDir, binDir, ["--timeout-ms", "soon"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}`, /--timeout-ms must be a non-negative number of milliseconds/);
  assert.match(`${result.stderr}`, /soon/);
});
