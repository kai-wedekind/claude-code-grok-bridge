import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  claimJobTerminal,
  listJobs,
  loadState,
  resolveJobFile,
  resolveStateFile,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";
import { reclaimOrphanedJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";

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

// ---------------------------------------------------------------------------
// DEFECT A — full/unwritable disk must not kill a healthy run
// reclaimOrphanedJob: claim terminal BEFORE terminate. If the claim cannot be
// recorded, no process may be killed.
// ---------------------------------------------------------------------------

test("DEFECT-disk: stale live reclaim does not terminate when terminal claim cannot be written", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const jobId = "job-stale-disk-full";
    const agentPid = 515101;
    const bridgePid = 515102;
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Healthy but progress unwritable",
      agentPid,
      bridgePid,
      pid: bridgePid,
      createdAt: old,
      updatedAt: old
    };
    writeJobFile(workspace, jobId, job);
    upsertJob(workspace, job);

    const terminated = [];
    const reclaimed = reclaimOrphanedJob(workspace, job, {
      isGoneImpl: () => false,
      terminateImpl: (pid) => {
        terminated.push(pid);
        return { attempted: true, delivered: true, method: "test" };
      },
      // Full / unwritable state volume: recording the abandon decision fails.
      claimTerminalImpl: () => {
        throw new Error("ENOSPC: no space left on device");
      }
    });

    assert.equal(
      terminated.length,
      0,
      "must not kill tracked processes when the terminal claim cannot be recorded"
    );
    assert.equal(
      reclaimed.status,
      "running",
      "job must stay active when abandon cannot be durably recorded"
    );
    assert.equal(reclaimed.agentPid, agentPid);
    assert.equal(reclaimed.bridgePid, bridgePid);

    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
    assert.equal(stored.status, "running", "on-disk record must remain active when claim fails");
  });
});

test("DEFECT-disk: stale live reclaim terminates only after a successful terminal claim", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const jobId = "job-stale-claim-ok";
    const agentPid = 515201;
    const bridgePid = 515202;
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Stale live, writable disk",
      agentPid,
      bridgePid,
      pid: bridgePid,
      createdAt: old,
      updatedAt: old
    };
    writeJobFile(workspace, jobId, job);
    upsertJob(workspace, job);

    const order = [];
    const reclaimed = reclaimOrphanedJob(workspace, job, {
      isGoneImpl: () => false,
      claimTerminalImpl: (cwd, id, status, patch) => {
        order.push("claim");
        return claimJobTerminal(cwd, id, status, patch);
      },
      terminateImpl: (pid) => {
        order.push(`terminate:${pid}`);
        return { attempted: true, delivered: true, method: "test" };
      }
    });

    assert.equal(reclaimed.status, "failed");
    assert.ok(order.includes("claim"), "must claim terminal");
    assert.ok(
      order.some((step) => step.startsWith("terminate:")),
      "must terminate after a successful claim"
    );
    assert.equal(order[0], "claim", "claim must happen before any terminate");
    assert.match(reclaimed.errorMessage || "", /abandon|stale|may still be running/i);
    assert.equal(reclaimed.agentPid, agentPid, "kill targets retained on abandon");
    assert.equal(reclaimed.bridgePid, bridgePid);
  });
});

test("DEFECT-disk: unclaimed terminal result (claimed:false) must not terminate", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const jobId = "job-claim-false";
    const agentPid = 515301;
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      agentPid,
      bridgePid: 515302,
      pid: 515302,
      createdAt: old,
      updatedAt: old
    };
    writeJobFile(workspace, jobId, job);
    upsertJob(workspace, job);

    const terminated = [];
    const reclaimed = reclaimOrphanedJob(workspace, job, {
      isGoneImpl: () => false,
      claimTerminalImpl: () => ({
        claimed: false,
        status: "running",
        job,
        reason: "write-failed"
      }),
      terminateImpl: (pid) => {
        terminated.push(pid);
        return { attempted: true, delivered: true, method: "test" };
      }
    });

    assert.equal(terminated.length, 0, "no kill when claim did not record the decision");
    assert.equal(reclaimed.status, "running");
  });
});

// ---------------------------------------------------------------------------
// DEFECT B — quarantining a corrupt state.json must not lose running work
// loadState: rebuild the index from durable job files after quarantine.
// ---------------------------------------------------------------------------

test("DEFECT-quarantine: corrupt state rebuilds index from job files; running work stays visible", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const now = new Date().toISOString();
    const runningId = "job-still-running";
    const doneId = "job-already-done";
    const damagedId = "job-damaged-record";

    writeJobFile(workspace, runningId, {
      id: runningId,
      status: "running",
      phase: "running",
      title: "Live work",
      agentPid: 616101,
      bridgePid: 616102,
      pid: 616102,
      createdAt: now,
      updatedAt: now
    });
    upsertJob(workspace, {
      id: runningId,
      status: "running",
      phase: "running",
      title: "Live work",
      agentPid: 616101,
      bridgePid: 616102,
      pid: 616102
    });

    writeJobFile(workspace, doneId, {
      id: doneId,
      status: "completed",
      phase: "done",
      title: "Finished",
      createdAt: now,
      updatedAt: now,
      result: { delivered: true, summary: "ok" }
    });
    upsertJob(workspace, {
      id: doneId,
      status: "completed",
      phase: "done",
      title: "Finished"
    });

    // Damaged job file: must not abort rebuild; must stay visible as damaged.
    writeJobFile(workspace, damagedId, {
      id: damagedId,
      status: "running",
      phase: "running",
      title: "Will be damaged"
    });
    upsertJob(workspace, {
      id: damagedId,
      status: "running",
      phase: "running",
      title: "Will be damaged"
    });
    fs.writeFileSync(resolveJobFile(workspace, damagedId), "{not-json truncated", "utf8");

    const stateFile = resolveStateFile(workspace);
    assert.equal(fs.existsSync(stateFile), true);
    fs.writeFileSync(stateFile, "{this is not valid json", "utf8");

    const stderrChunks = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(String(chunk));
      return originalWrite.call(process.stderr, chunk, ...rest);
    };

    let state;
    try {
      // Must not wipe to empty and must not leave the workspace unlistable.
      assert.doesNotThrow(() => {
        state = loadState(workspace);
      }, "loadState must recover from corrupt index rather than only throwing");
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.ok(state, "loadState must return a usable state");
    const ids = new Set((state.jobs ?? []).map((j) => j.id));
    assert.ok(ids.has(runningId), "running job from jobs/ must reappear in the rebuilt index");
    assert.ok(ids.has(doneId), "completed job from jobs/ must reappear in the rebuilt index");
    assert.ok(ids.has(damagedId), "damaged job record must stay visible after rebuild");

    const running = state.jobs.find((j) => j.id === runningId);
    assert.equal(running.status, "running");
    assert.equal(running.agentPid, 616101);

    const damaged = state.jobs.find((j) => j.id === damagedId);
    assert.equal(
      damaged.damaged === true || /damag/i.test(damaged.errorMessage || damaged.phase || ""),
      true,
      "damage must remain visible on the rebuilt record"
    );

    // Quarantine must still be surfaced to the operator.
    const dirEntries = fs.readdirSync(path.dirname(stateFile));
    assert.ok(
      dirEntries.some((name) => name.startsWith("state.json.corrupt-")),
      "corrupt state.json must be quarantined aside"
    );
    const notice = stderrChunks.join("");
    assert.match(
      notice,
      /corrupt|quarantin/i,
      "operator must be told the state file was corrupt (do not silence quarantine)"
    );

    // listJobs / runs path must also see the work after recovery.
    const listed = listJobs(workspace);
    assert.ok(listed.some((j) => j.id === runningId && j.status === "running"));
    assert.ok(listed.some((j) => j.id === doneId && j.status === "completed"));
  });
});

// path is used for dirname of state file
import path from "node:path";
