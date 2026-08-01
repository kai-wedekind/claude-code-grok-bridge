/**
 * The completion sentinel is gone, and its litter is swept.
 *
 * This file used to assert that a terminal claim leaves a `<job>.done` marker for a watcher
 * to wait on. The marker was real and the assertions were true; what none of them asked was
 * whether anything watched. Nothing did — no command, no hook, no production path. The one
 * consumer of `resolveJobDoneFile` was this test, which is the shape of a mechanism that
 * exists only because it was written.
 *
 * The incident it was built for (a caller waiting 25 minutes on 2026-07-28 for a result that
 * was already complete on disk) had a different cause: an agent ran `git init`, the record
 * moved to a second workspace directory, and no reader could find it by id. The sealed
 * `--workspace-root` is what fixed that.
 *
 * So the marker is no longer written, and — since nothing ever deleted one — deleting a job
 * record now sweeps any marker an older version left beside it.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  claimJobTerminal,
  cleanTerminalJobs,
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";

function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
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

function seed(workspace, id) {
  const now = new Date().toISOString();
  const job = {
    id,
    sessionId: "s",
    status: "running",
    phase: "running",
    jobClass: "task",
    title: "a run",
    workspaceRoot: workspace,
    createdAt: now,
    updatedAt: now,
    logFile: null
  };
  writeJobFile(workspace, id, job);
  upsertJob(workspace, job);
}

test("a terminal claim no longer writes a marker nobody reads", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    seed(workspace, "run-sentinel");

    const claim = claimJobTerminal(workspace, "run-sentinel", "completed", { phase: "done" });

    assert.equal(claim.claimed, true, "the outcome itself is still recorded");
    assert.equal(
      fs.existsSync(`${resolveJobFile(workspace, "run-sentinel")}.done`),
      false,
      "a write-only signal is not a feature"
    );
  });
});

test("cleaning a job sweeps a marker an older version left behind", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    seed(workspace, "run-legacy-marker");
    claimJobTerminal(workspace, "run-legacy-marker", "completed", { phase: "done" });

    const jobFile = resolveJobFile(workspace, "run-legacy-marker");
    const marker = `${jobFile}.done`;
    fs.writeFileSync(marker, "completed\n2026-07-30T00:00:00.000Z\n", "utf8");

    const result = cleanTerminalJobs(workspace, {});

    assert.deepEqual(result.removed, ["run-legacy-marker"]);
    assert.equal(fs.existsSync(jobFile), false);
    assert.equal(fs.existsSync(marker), false, "an installation should not keep the litter");
    assert.equal(
      fs.existsSync(path.dirname(jobFile)),
      true,
      "and the sweep must stay inside the jobs directory"
    );
  });
});
