import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import {
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

// The detached worker reads its job record from disk. That record is a file a crash can
// truncate and anything running as this user can edit, so the worker must take its
// identity and its working directory from the command line the parent gave it, and use
// the record only for the payload.

/**
 * Seeding writes through the same state helpers the worker reads with, so the state
 * root env var has to be set in THIS process too — not only in the child's env.
 */
function withStateRoot(pluginDataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function seedQueuedJob(workspace, id, request, overrides = {}) {
  const record = {
    id,
    status: "queued",
    kind: "task",
    kindLabel: "Run",
    title: "Worker record",
    jobClass: "task",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    request,
    ...overrides
  };
  writeJobFile(workspace, id, record);
  upsertJob(workspace, {
    id,
    status: record.status,
    kind: record.kind,
    kindLabel: record.kindLabel,
    title: record.title,
    jobClass: record.jobClass
  });
  return record;
}

test("worker refuses a record whose id does not match the requested job", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir });

  const jobId = "run-argvtest-aaaa";
  withStateRoot(pluginDataDir, () => {
    seedQueuedJob(workspace, jobId, { prompt: "hello", cwd: workspace });
    // Simulate the record being damaged or tampered with so it names a different run.
    const jobFile = resolveJobFile(workspace, jobId);
    const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    stored.id = "run-someone-elses-bbbb";
    fs.writeFileSync(jobFile, JSON.stringify(stored));
  });

  const result = run(
    process.execPath,
    [SCRIPT, "run-worker", "--cwd", workspace, "--job-id", jobId],
    { env }
  );

  assert.notEqual(result.status, 0, "a mismatched record must not be executed");
  assert.match(
    `${result.stderr}${result.stdout}`,
    /claims id|not the one requested/i,
    "the refusal must say what was wrong"
  );
});

test("worker runs in the cwd from argv, not the one stored in the record", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "echo-cwd");
  const pluginDataDir = makeTempDir();
  const realWorkspace = makeTempDir();
  const otherDir = makeTempDir();
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir });

  const jobId = "run-argvtest-cccc";
  // The record points somewhere else entirely — the worker must ignore that.
  withStateRoot(pluginDataDir, () => {
    seedQueuedJob(realWorkspace, jobId, { prompt: "where am I", cwd: otherDir });
  });

  const result = run(
    process.execPath,
    [SCRIPT, "run-worker", "--cwd", realWorkspace, "--job-id", jobId],
    { env }
  );

  assert.equal(result.status, 0, result.stderr);
  const stored = withStateRoot(pluginDataDir, () =>
    JSON.parse(fs.readFileSync(resolveJobFile(realWorkspace, jobId), "utf8"))
  );
  const reported = stored.result?.rawOutput ?? stored.rendered ?? "";
  assert.match(reported, /CWD:/, "the fixture must have reported its working directory");
  assert.equal(
    fs.realpathSync(reported.match(/CWD:(.*)/)[1].trim()),
    fs.realpathSync(realWorkspace),
    "the agent must run where argv said, not where the record said"
  );
});
