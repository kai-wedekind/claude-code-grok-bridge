import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import {
  listJobs,
  resolveStateDir,
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
    title: "a background run",
    workspaceRoot: workspace,
    createdAt: now,
    updatedAt: now,
    logFile: null
  };
  writeJobFile(workspace, id, job);
  upsertJob(workspace, job);
}

// The field report of 2026-07-28, reduced to its mechanism.
//
// A workspace's identity comes from resolveWorkspaceRoot, which answers with the git
// root and falls back to the raw path when there is no repository. That answer is not
// constant for the life of a run: a --write agent asked to set up a project runs
// `git init`, and from that moment the same cwd resolves somewhere else. Three
// background runs were created under <cwd> with no repo around, the agent created one
// 43 seconds in, and every later write — progress, and above all the terminal claim —
// addressed the parent's directory instead of the record's own. The records stayed
// "running" for good, `runs <id>` answered "No run found" for an id that was sitting in
// state.json, and three finished results went unnoticed on disk for 25 minutes.
test("a job stays findable when a repository appears above its workspace", () => {
  withPluginData(() => {
    const parent = makeTempDir();
    const workspace = path.join(parent, "ws_a");
    fs.mkdirSync(workspace);

    const before = resolveStateDir(workspace);
    seed(workspace, "run-relocation");
    assert.equal(listJobs(workspace).length, 1, "precondition: the job is recorded");

    // The agent sets up a project. Nothing malicious, nothing unusual.
    execFileSync("git", ["init", "-q"], { cwd: parent, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: parent, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: parent, stdio: "ignore" });

    const after = resolveStateDir(workspace);
    assert.equal(
      after,
      before,
      "the state directory must not move under a run just because git appeared above it"
    );

    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1, "the job must still be findable — this is what stranded three runs");
    assert.equal(jobs[0].id, "run-relocation");
  });
});

// The stickiness must not capture workspaces that have no state yet: a fresh cwd inside
// a repository still belongs to the repository, which is what keeps runs from the same
// project together.
test("a workspace with no state yet still resolves to its repository root", () => {
  withPluginData(() => {
    const repo = makeTempDir();
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    const sub = path.join(repo, "packages", "thing");
    fs.mkdirSync(sub, { recursive: true });

    assert.equal(
      resolveStateDir(sub),
      resolveStateDir(repo),
      "without an existing state directory the git root still wins"
    );
  });
});
