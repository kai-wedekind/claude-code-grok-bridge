// The parent must not patch status, phase and agentPid again after spawn: a worker that had
// already marked the job running would lose that progress, and stop would lose the grok pid
// (upstream #61).
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { enqueueBackgroundJob } from "../plugins/grok-build/scripts/grok-bridge.mjs";
import {
  generateJobId,
  listJobs,
  patchJobIfActive,
  resolveStateDir
} from "../plugins/grok-build/scripts/lib/state.mjs";

test("enqueueBackgroundJob keeps a worker's running state and agentPid when the worker patches first", () => {
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const job = {
      id: generateJobId("run"),
      kind: "task",
      kindLabel: "delegate",
      title: "Grok Build Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "post-spawn patch",
      write: false
    };

    const result = enqueueBackgroundJob(
      repo,
      job,
      { kind: "task", cwd: repo, prompt: "hello", write: false, resumeLast: false, jobId: job.id },
      {
        spawnWorker(_cwd, jobId) {
          // Drive the two writes in order. No real race: the worker patch lands, then
          // enqueueBackgroundJob applies the post-spawn patch on return.
          patchJobIfActive(repo, jobId, {
            status: "running",
            phase: "running",
            agentPid: 515151,
            threadId: "thread-race"
          });
          return { pid: 424242 };
        }
      }
    );

    assert.equal(result.payload.pid, 424242);
    assert.equal(result.payload.bridgePid, 424242);

    const jobFile = path.join(resolveStateDir(repo), "jobs", `${job.id}.json`);
    const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    assert.equal(stored.status, "running");
    assert.equal(stored.phase, "running");
    assert.equal(stored.agentPid, 515151);
    assert.equal(stored.threadId, "thread-race");
    assert.equal(stored.pid, 424242);
    assert.equal(stored.bridgePid, 424242);
    assert.equal(stored.bridgeImage, path.basename(process.execPath));
    assert.equal(typeof stored.logFile, "string");

    const indexed = listJobs(repo).find((entry) => entry.id === job.id);
    assert.equal(indexed.status, "running");
    assert.equal(indexed.agentPid, 515151);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
