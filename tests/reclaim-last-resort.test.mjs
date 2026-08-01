import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { reclaimOrphanedJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { resolveJobFile, upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

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

// Finding H from the orchestrated review. A record with no kill targets and no parseable
// date could never be reclaimed: the guard returned early on every pass, and nothing else
// can recover that state either, because there is no process left to observe as dead. The
// file's own mtime is maintained by the filesystem whether or not the content is sane.
test("a record with no usable date is still reclaimable via its file mtime", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const job = {
      id: "run-no-date",
      sessionId: "s",
      status: "running",
      phase: "running",
      jobClass: "task",
      title: "a run whose dates are unreadable",
      workspaceRoot: workspace,
      createdAt: "not a date",
      updatedAt: "also not a date",
      logFile: null
    };
    writeJobFile(workspace, job.id, job);
    upsertJob(workspace, job);

    // Old enough to be past every grace period, supplied rather than waited for.
    const lange_her = Date.now() - 48 * 60 * 60 * 1000;
    const out = reclaimOrphanedJob(workspace, job, {
      jobMtimeImpl: () => lange_her
    });

    assert.equal(out.status, "failed", "an unreadable date must not confer immortality");
    assert.equal(out.usageIncomplete, true, "and its spend is unknown, not zero");
  });
});

test("a fresh record with no usable date is still left alone", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const job = {
      id: "run-fresh-no-date",
      sessionId: "s",
      status: "running",
      phase: "running",
      jobClass: "task",
      title: "a run that just started",
      workspaceRoot: workspace,
      createdAt: "nonsense",
      updatedAt: "nonsense",
      logFile: null
    };
    writeJobFile(workspace, job.id, job);
    upsertJob(workspace, job);

    const out = reclaimOrphanedJob(workspace, job, { jobMtimeImpl: () => Date.now() });
    assert.equal(out.status, "running", "the fallback must not become a hair trigger");
  });
});

// Finding G: the claim payload sets usageIncomplete, the fallback object did not, so a
// caller trusting the return value without re-reading saw a reclaimed run whose spend
// looked accounted for when it had never been accounted for at all.
test("the fallback object carries the unknown-spend flag too", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const job = {
      id: "run-fallback",
      sessionId: "s",
      status: "running",
      phase: "running",
      jobClass: "task",
      title: "a run whose claim cannot be stored",
      workspaceRoot: workspace,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      logFile: null
    };
    writeJobFile(workspace, job.id, job);
    upsertJob(workspace, job);

    const out = reclaimOrphanedJob(workspace, job, {
      // A claim that reports nothing back: the shape that falls through to the literal.
      claimTerminalImpl: () => ({ claimed: true, status: "failed", job: null })
    });

    assert.equal(out.status, "failed");
    assert.equal(out.usageIncomplete, true, "the fallback must say the spend is unknown");
  });
});
