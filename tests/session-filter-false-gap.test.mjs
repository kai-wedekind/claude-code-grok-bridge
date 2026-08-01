import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";
import { buildStatusSnapshot } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { renderStatusReport } from "../plugins/grok-build/scripts/lib/render.mjs";
// Imported, not spelled out again: this file used to declare its own
// SESSION_ID_ENV = "CLAUDE_SESSION_ID", a name nothing in the bridge reads. The
// subprocess therefore ran with no session id at all, and the assertions below passed
// only when the ambient environment happened to carry a real GROK_CC_SESSION_ID — inside
// a Claude session it does, from a bare shell it does not. A test that green-lights on
// an inherited variable is measuring the machine it runs on. (Found 2026-07-31, when the
// suite went red under PowerShell and identically red on the unchanged commit.)
import { SESSION_ID_ENV } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function withPluginData(pluginDataDir, fn) {
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

function seedFinishedJob(workspace, id, sessionId) {
  const now = new Date().toISOString();
  const job = {
    id,
    sessionId,
    status: "completed",
    phase: "completed",
    jobClass: "task",
    title: `run ${id}`,
    workspaceRoot: workspace,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    logFile: null
  };
  writeJobFile(workspace, id, job);
  upsertJob(workspace, job);
}

// A real incident on 2026-07-28: a session's id changed under it (fork), the session
// filter hid its own in-flight run, `runs` answered "No runs recorded yet", and the
// caller concluded the run was lost. It was not — it finished, and its result and its
// booked spend were sitting on disk the whole time. An empty filter must never be rendered
// as an empty workspace.
test("an empty session filter is not reported as an empty workspace", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();

  withPluginData(pluginDataDir, () => {
    seedFinishedJob(workspace, "run-from-old-session", "session-before-the-fork");

    const snapshot = buildStatusSnapshot(workspace, { sessionId: "session-after-the-fork" });
    assert.equal(snapshot.recent.length, 0, "the other session's run stays out of the listing");
    assert.equal(snapshot.hiddenBySessionFilter, 1, "but the report must know it exists");

    const rendered = renderStatusReport(snapshot);
    assert.doesNotMatch(
      rendered,
      /No runs recorded yet/,
      "claiming nothing was ever started is the false gap that cost a paid result"
    );
    assert.match(rendered, /1 run from other sessions/);
    assert.match(rendered, /--all-sessions/, "the way out has to be named where it is needed");
  });
});

test("a genuinely empty workspace still says so plainly", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();

  withPluginData(pluginDataDir, () => {
    const snapshot = buildStatusSnapshot(workspace, { sessionId: "any-session" });
    assert.equal(snapshot.hiddenBySessionFilter, 0);
    assert.match(renderStatusReport(snapshot), /No runs recorded yet/);
  });
});

test("--all-sessions reaches the run the filter hid", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();

  withPluginData(pluginDataDir, () => {
    seedFinishedJob(workspace, "run-from-old-session", "session-before-the-fork");
  });

  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    [SESSION_ID_ENV]: "session-after-the-fork"
  };

  const hidden = run(process.execPath, [SCRIPT, "runs", "--cwd", workspace], { env });
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.match(hidden.stdout, /from other sessions/, "the pointer must survive to the CLI");

  const all = run(process.execPath, [SCRIPT, "runs", "--all-sessions", "--cwd", workspace], { env });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /run-from-old-session/, "and following it must actually show the run");
});
