/**
 * A run that was killed before it could account for itself is UNKNOWN, never invisible.
 *
 * The ledger skips any record with no usage, no cost and no incomplete flag. A hard kill
 * leaves exactly that: the bridge process dies before writing a terminal state, so the
 * record sits on `running` forever with nothing attached. It was not counted as a run and
 * not reported as incomplete — the spend simply ceased to exist.
 *
 * Found 2026-08-01 during a clean reinstall, by counting job files against
 * the ledger: seven records in the acceptance suite's workspace, six in the ledger. Step 8
 * of that suite kills a run on purpose, so EVERY acceptance run has been losing the cost of
 * exactly one real Grok run — roughly seven percent of the suite — in the very figure the
 * weekly calibration is built from. Nothing pointed at it; `incompleteRuns` said 0.
 *
 * The module already applies this principle to a job file that will not parse ("Swallowing
 * it counted that run as an exact zero, which is the same dishonesty the usageIncomplete
 * flag exists to prevent"). This is that case arrived at through a killed process.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { collectUsage } from "../plugins/grok-build/scripts/lib/usage-ledger.mjs";

function withStateRoot(root, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = root;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

/**
 * One job record on disk, in the layout the ledger walks.
 *
 * Workspaces sit DIRECTLY under the state root — `<root>/<workspace>/jobs/<id>.json`, not
 * `<root>/state/…`. The first version of this helper added the extra segment, so the ledger
 * found nothing and all three tests agreed with it: the two that assert zero passed
 * vacuously. A fixture in the wrong place makes a negative assertion meaningless, and only
 * the positive test noticed.
 */
function seedRecord(root, workspace, id, job) {
  const jobsDir = path.join(root, workspace, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(jobsDir, `${id}.json`),
    JSON.stringify({ id, createdAt: now, updatedAt: now, ...job }),
    "utf8"
  );
}

// The probe is injected rather than aimed at a magic pid, because no pid number is reliably
// dead: the answer is the operating system's to give, and a fixture that depends on it tests
// the host rather than the code.
//
// ⚠ This comment used to state that 2147483646 raises EINVAL rather than ESRCH on Windows,
// as the reason the first version of this test failed. Re-measured 2026-08-01 on Windows 11
// with Node v22.23.1 and it does NOT reproduce — that pid, a legal-but-unused high pid, and
// a pid that genuinely existed and exited all raise ESRCH, while a live process does not
// throw at all. Whatever broke the first attempt, the recorded diagnosis was wrong or has
// since changed. The injected probe is still the right design for the reason above, so the
// test is unaffected; the claim is corrected because an unreproducible measurement in a
// comment is worse than no comment.
const ALL_DEAD = () => true;

test("a killed run is counted as unknown spend, not skipped", () => {
  const root = makeTempDir();
  withStateRoot(root, () => {
    seedRecord(root, "ws-a", "run-stranded", {
      status: "running",
      phase: "running",
      title: "Grok Build Thread (orphanaccept)",
      agentPid: 4321,
      bridgePid: 4322
    });

    const ledger = collectUsage({ days: 7, stateRoot: root, isProcessGoneImpl: ALL_DEAD });

    assert.equal(ledger.runs, 1, "the run happened, so the ledger has to know about it");
    assert.equal(ledger.incompleteRuns, 1, "and has to say that its spend is unknown");
    assert.equal(ledger.runsWithCost, 0, "there is no cost to report — that is the point");
  });
});

test("a job that is genuinely still running is not cried wolf over", () => {
  // Liveness, not status alone. A live run accounts for itself when it finishes; flagging
  // it on every `usage` call in the meantime would make the incomplete count meaningless.
  const root = makeTempDir();
  withStateRoot(root, () => {
    seedRecord(root, "ws-b", "run-live", {
      status: "running",
      phase: "running",
      agentPid: process.pid,
      bridgePid: process.pid
    });

    // Real probe: this process is demonstrably alive.
    const ledger = collectUsage({ days: 7, stateRoot: root });

    assert.equal(ledger.incompleteRuns, 0, "this process is demonstrably alive");
    assert.equal(ledger.runs, 0, "and it is not yet a run with anything to report");
  });
});

test("a live pid does not rescue a record that has been silent for days", () => {
  // The defect that survived inside the first version of the fix. Pids recycle: measured
  // 2026-08-01 on the real state root, two records from 26.07. and 28.07. still claimed to
  // be running AND probed as alive, five and six days later — their numbers belong to other
  // processes now. Liveness alone would have kept them invisible for good.
  const root = makeTempDir();
  withStateRoot(root, () => {
    const daysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    seedRecord(root, "ws-d", "run-recycled", {
      status: "running",
      phase: "running",
      // This process is genuinely alive, so the liveness probe says "not gone".
      agentPid: process.pid,
      bridgePid: process.pid,
      createdAt: daysAgo,
      updatedAt: daysAgo
    });

    const ledger = collectUsage({ days: 7, stateRoot: root });

    assert.equal(ledger.incompleteRuns, 1, "silence past the stale threshold decides it");
    assert.equal(ledger.runs, 1);
  });
});

test("a state root that never existed says so instead of reporting a clean zero", () => {
  // Two zeros that looked identical: "nothing was spent" and "there is nothing HERE".
  // Reading the report even creates the directory — the subscription cache writes under
  // the state root — so by the time the walk finds nothing, the root exists and looks like
  // an ordinary empty one. It reads as a clean zero during a clean reinstall, and the temp
  // fallback root produces the same illusion for a different reason.
  const missingRoot = path.join(makeTempDir(), "this-state-root-does-not-exist");

  const ledger = collectUsage({ days: 7, stateRoot: missingRoot });

  assert.equal(ledger.stateRootExisted, false, "the report has to carry the distinction");
  assert.equal(ledger.stateRoot, missingRoot, "and name the place it looked");
  assert.equal(ledger.costUsd, 0, "the zero itself is still correct — it just means something else");
});

test("an existing state root is not flagged", () => {
  const existingRoot = makeTempDir();
  const ledger = collectUsage({ days: 7, stateRoot: existingRoot });
  assert.equal(ledger.stateRootExisted, true);
});

test("a queued job with no process behind it is not unknown spend", () => {
  // It has not started, so nothing has been spent. "Unknown" would be the wrong claim —
  // the same distinction the stop path makes before flagging usageIncomplete.
  const root = makeTempDir();
  withStateRoot(root, () => {
    seedRecord(root, "ws-c", "run-queued", {
      status: "queued",
      phase: "queued",
      pid: null,
      agentPid: null,
      bridgePid: null
    });

    // Even with a probe that declares everything dead: with no targets there is nothing
    // to book.
    const ledger = collectUsage({ days: 7, stateRoot: root, isProcessGoneImpl: ALL_DEAD });

    assert.equal(ledger.incompleteRuns, 0);
    assert.equal(ledger.runs, 0);
  });
});
