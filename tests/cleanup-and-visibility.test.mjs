/**
 * Four things that never go wrong in a way anyone notices — which is why they are here.
 *
 * Found 2026-07-31 by a review pass that read the module end to end rather than looking for a
 * specific class of defect. That is the only way any of these turn up: each one is correct
 * on the happy path and wrong only in a window, or wrong only in what it does NOT say.
 *
 *   cleanTerminalJobs deleted files before writing the index, against the invariant the
 *     rest of the module keeps
 *   the completion sentinel had no consumer and no sweeper   → done-sentinel.test.mjs
 *   the detached worker had no 'error' listener
 *   the thread-lock heartbeat swallowed persistent failures
 */
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  acquireThreadLock,
  cleanTerminalJobs,
  claimJobTerminal,
  listJobs,
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

function seedTerminal(workspace, id) {
  const now = new Date().toISOString();
  const job = {
    id,
    sessionId: "s",
    status: "running",
    phase: "running",
    jobClass: "task",
    title: id,
    workspaceRoot: workspace,
    createdAt: now,
    updatedAt: now,
    logFile: null
  };
  writeJobFile(workspace, id, job);
  upsertJob(workspace, job);
  claimJobTerminal(workspace, id, "completed", { phase: "done" });
}

test("clean writes the index before it deletes anything", () => {
  // The window: with files first, a crash between the two leaves the index naming records
  // whose files are gone — permanently, and every reader then has to handle "listed but
  // unreadable". The other order leaves an orphaned file nothing points at, which is
  // invisible and swept next time.
  withPluginData(() => {
    const workspace = makeTempDir();
    seedTerminal(workspace, "run-gone");
    const jobFile = resolveJobFile(workspace, "run-gone");

    // Simulate the crash by making the deletion throw: the index must already be correct.
    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = (target) => {
      if (String(target).includes("run-gone")) {
        throw new Error("simulated crash during file deletion");
      }
      return realUnlink(target);
    };

    try {
      assert.throws(() => cleanTerminalJobs(workspace, {}));
    } finally {
      fs.unlinkSync = realUnlink;
    }

    assert.equal(fs.existsSync(jobFile), true, "the file survived the simulated crash");
    assert.equal(
      listJobs(workspace).some((job) => job.id === "run-gone"),
      false,
      "and the index had already been written, so no reader sees a record it cannot open"
    );
  });
});

test("the detached worker spawn has an error listener", () => {
  // A source-shaped assertion, and labelled as one. The event it guards is an asynchronous
  // spawn failure — EAGAIN, EMFILE — which cannot be provoked on demand from a test, and
  // without a listener it is an unhandled error that kills this process AFTER it has told
  // the caller the run was queued. What can be asserted mechanically is that the listener is
  // still there, which is the thing a later edit would quietly remove.
  const path = new URL("../plugins/grok-build/scripts/grok-bridge.mjs", import.meta.url);
  const source = fs.readFileSync(path, "utf8");
  const start = source.indexOf("function spawnDetachedRunWorker");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("\n}", start));

  assert.match(body, /child\.on\("error"/, "an unhandled 'error' event takes the process down");
  assert.match(body, /claimJobTerminal\(/, "and the record must say why, not stay queued forever");
});

test("a heartbeat that keeps failing says so, exactly once", async () => {
  // The condition worth reporting is not "the lock is gone" — that is somebody else's
  // business and the token check handles it — but "we still hold it and cannot refresh it".
  // A lock that stops being refreshed is one the age backstop will hand to another run
  // while this one is still working, and the old loop's bare `catch {}` made that
  // indistinguishable from a healthy beat.
  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  const realUtimes = fs.utimesSync;
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();

  let handle = null;
  try {
    const workspace = makeTempDir();
    handle = acquireThreadLock(workspace, "beating", { heartbeatMs: 10 });
    assert.ok(handle, "the lock must be free in a fresh workspace");

    process.stderr.write = (chunk, ...rest) => {
      written.push(String(chunk));
      return true;
    };
    fs.utimesSync = () => {
      throw new Error("simulated: the state volume stopped accepting writes");
    };

    // Long enough for well over the three consecutive failures the warning waits for.
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    fs.utimesSync = realUtimes;
    process.stderr.write = realWrite;
    try {
      handle?.release();
    } catch {
    }
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }

  const warnings = written.filter((line) => line.includes('thread "beating"'));
  assert.equal(warnings.length, 1, "said once — a per-tick message would bury the run's output");
  assert.match(warnings[0], /may reclaim it/);
});
