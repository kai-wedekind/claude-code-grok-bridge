/**
 * The identity of a running agent — three of the four facets of one finding.
 *
 * Three review passes arrived at the same subject from different questions on 2026-07-31, which is
 * the kind of agreement that matters when the reviewers never saw each other's prompts. The
 * subject is: this plugin holds a pid on disk and later acts on it, and every step between
 * those two moments is a chance to act on the wrong one — or to forget the right one.
 *
 *   (a) retention dropped the sole pointer to a live agent        → cancel-survivor.test.mjs
 *   (b) the worker nulled pids that stop had just restored        → here
 *   (c) a kill target with no recorded image was signalled blind  → here
 *   (d) hasSurvivingAgent ignored the legacy companionPid field   → here
 *
 * (a) and (b) lose a live agent. (c) kills a stranger. (d) feeds (a) by filling the bucket
 * with records that are not survivors at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { makeTempDir } from "./helpers.mjs";
import { pruneJobs } from "../plugins/grok-build/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import {
  jobProcessImageCandidates,
  terminateProcessTree
} from "../plugins/grok-build/scripts/lib/process.mjs";

/* (b) --------------------------------------------------------------------------------- */

test("when stop wins the claim, the worker does not null the pids stop restored", async () => {
  // Sequence being pinned: stop claims the record, nulls the pids, kills, finds the kill was
  // NOT delivered, and writes the survivor's pids back so somebody can still aim at it. This
  // worker's write lands after all of that. Nulling here erases the restore.
  const patches = [];
  const claimTerminalImpl = (workspaceRoot, jobId, status, patch) => {
    patches.push({ status, patch });
    // First call: the worker's ordinary completion claim, which stop already beat.
    if (patches.length === 1) {
      return { claimed: false, status: "cancelled", reason: "already-terminal", job: {} };
    }
    return { claimed: true, status, job: {} };
  };

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    await runTrackedJob(
      { id: "run-abc123", workspaceRoot: makeTempDir(), title: "t", kind: "run" },
      async () => ({ exitStatus: 0, payload: {}, rendered: "done\n", summary: "s" }),
      { claimTerminalImpl, logFile: null }
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }

  const cancelPatch = patches.at(-1);
  assert.equal(cancelPatch.status, "cancelled");
  for (const key of ["agentPid", "pid", "bridgePid"]) {
    assert.ok(
      !(key in cancelPatch.patch),
      `${key} must be OMITTED, not nulled — an omitted key keeps what stop decided, and ` +
        `null erases the pid of an agent that is probably still running`
    );
  }
});

/* (c) --------------------------------------------------------------------------------- */

test("a kill target with no recorded image is still checked before it is signalled", () => {
  // The record says "pid 4321" and nothing else. Pids are reissued and a record can sit on
  // disk for days, so signalling it unchecked is a terminate-anything primitive aimed by a
  // stale file. What the process must at least be: something a run can have started.
  const stranger = terminateProcessTree(4321, {
    platform: "win32",
    // The image question only arises for a process that EXISTS — since 2026-08-01
    // terminateProcessTree skips it for a corpse. 4321 exists on no test machine, so the
    // fixture has to assert liveness explicitly rather than let the real probe answer.
    isGoneImpl: () => false,
    readImageImpl: () => "notepad.exe",
    runCommandImpl: () => {
      throw new Error("must not reach the kill");
    }
  });

  assert.equal(stranger.method, "image-mismatch");
  assert.equal(stranger.attempted, false);
  assert.equal(stranger.actualImage, "notepad.exe");
});

test("the two images a run can start are accepted without a recorded image", () => {
  let killed = null;
  const outcome = terminateProcessTree(4321, {
    platform: "win32",
    readImageImpl: () => "grok.exe",
    runCommandImpl: (command, args) => {
      killed = { command, args };
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(outcome.method, "taskkill");
  assert.equal(killed.command, "taskkill");
  assert.ok(killed.args.includes("4321"));
});

test("a probe that cannot read the image still allows the kill", () => {
  // Unchanged policy, and deliberately so: it is about platforms where the image cannot be
  // read at all, not about records that never wrote one down.
  let killed = false;
  const outcome = terminateProcessTree(4321, {
    platform: "win32",
    readImageImpl: () => null,
    runCommandImpl: () => {
      killed = true;
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(outcome.delivered, true);
  assert.equal(killed, true);
});

test("a renamed grok binary is one of the candidates", () => {
  const candidates = jobProcessImageCandidates({ GROK_BINARY: "/opt/tools/grok-cli" });
  assert.ok(candidates.includes("grok-cli"), "GROK_BINARY is documented; honour it here too");
  assert.ok(candidates.some((name) => name.startsWith("node")), "the bridge is this interpreter");
});

test("stop keeps the kill targets when it REFUSED to kill", () => {
  // The consequence of the refusal above, one layer up, and the reason the two belong in
  // one file. Stop's sequence is: null the pids, kill, and put them back when the kill did
  // not land. That last step used to be gated on `killResult.attempted` — and a refusal
  // reports attempted:false with no kill performed at all, so the single outcome where the
  // process is most certainly still alive was the one that skipped the restore. The record
  // then ends cancelled, pointing at nobody, while the agent keeps spending.
  //
  // SessionEnd learned this on 2026-07-28 (see the comment at session-lifecycle-hook.mjs
  // ~96) and the stop path did not. It stayed latent while refusals could only follow a
  // RECORDED image mismatch; making an unrecorded image refuse too is what widened it.
  const source = readFileSync(
    new URL("../plugins/grok-build/scripts/grok-bridge.mjs", import.meta.url),
    "utf8"
  );
  const gate = source.match(/if \(([^)]*killResult\.delivered[^)]*)\) \{\s*\n\s*patchStoppedJobKillTargets/);

  assert.ok(gate, "the restore gate must still be findable");
  assert.doesNotMatch(
    gate[1],
    /killResult\.attempted/,
    "gating the restore on `attempted` drops the pids of a process nobody even shot at"
  );
  assert.match(gate[1], /!killResult\.delivered/, "not-delivered is the whole question");
});

/* (d) --------------------------------------------------------------------------------- */

test("a legacy record whose bridge pid is called companionPid is not a survivor", () => {
  // `companionPid` is the pre-rename name for bridgePid, accepted by six other read sites.
  // Read as an agent pid, an ordinary finished run occupies a slot in a bucket capped at
  // MAX_JOBS — and the record it crowds out is a real survivor.
  const jobs = [];
  for (let index = 0; index < 60; index += 1) {
    jobs.push({
      id: `run-legacy-${index}`,
      status: "completed",
      pid: 6000 + index,
      companionPid: 6000 + index,
      updatedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000).toISOString()
    });
  }
  for (let index = 0; index < 60; index += 1) {
    jobs.push({
      id: `run-plain-${index}`,
      status: "completed",
      pid: null,
      agentPid: null,
      bridgePid: 5000 + index,
      updatedAt: new Date(Date.parse("2026-02-01T00:00:00.000Z") + index * 1000).toISOString()
    });
  }

  // Every pid reported alive, so a misclassified record cannot be swept out of the survivor
  // bucket and hide the defect: misclassified gives 50 survivors + 50 terminal = 100.
  const kept = pruneJobs(jobs, { isGone: () => false });

  assert.equal(kept.length, 50, "all 120 are ordinary finished runs and share one cap");
});
