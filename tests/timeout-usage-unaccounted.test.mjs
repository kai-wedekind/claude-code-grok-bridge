import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { collectUsage } from "../plugins/grok-build/scripts/lib/usage-ledger.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function timedOutRun(pluginDataDir) {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "hang");
  const workspace = makeTempDir();
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir });

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--timeout-ms", "1500", "--cwd", workspace, "work forever"],
    { env }
  );

  return { result, workspace };
}

// Measured against the real CLI on 2026-07-28: a run killed after 20 seconds had burned
// tokens and moved the ledger by exactly nothing — it was not counted as a run,
// not as cost, and not as an unknown. `usage_is_incomplete` only ever arrives inside the
// CLI's closing envelope, which a killed process never sends, so the record claimed full
// accounting for a run that produced none, and the ledger's skip rule dropped it.
test("a timed-out run is marked as unaccounted, not as fully accounted", () => {
  const pluginDataDir = makeTempDir();
  const { result } = timedOutRun(pluginDataDir);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "timeout");
  assert.equal(payload.usage, null, "a killed CLI cannot report usage");
  assert.equal(payload.costTicks, null);
  assert.equal(
    payload.usageIncomplete,
    true,
    "no usage plus a failure means the spend is unknown — saying it is complete hides it"
  );
});

test("the ledger counts the unaccounted run and says so out loud", () => {
  const pluginDataDir = makeTempDir();
  timedOutRun(pluginDataDir);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  let report;
  try {
    report = collectUsage({ days: 1, includeTestWorkspaces: true });
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }

  assert.equal(report.runs, 1, "the run must appear at all — dropping it understates the week");
  assert.equal(report.incompleteRuns, 1, "and must be visible as an unknown, not as zero");
  assert.equal(report.runsWithCost, 0, "no cost is claimed, because none is known");
  assert.equal(report.costUsd, 0);
});

// The flag must stay off where accounting really did happen, or every ordinary run would
// be reported as an unknown and the ledger would become useless in the other direction.
test("a successful run is not marked unaccounted", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "text-plus-usage-object");
  const pluginDataDir = makeTempDir();
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir });

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", makeTempDir(), "do the thing"],
    { env }
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode ?? null, null);
  assert.equal(payload.usageIncomplete, false, "a run that reported its usage is accounted for");
});

// A failure that DOES carry usage must keep its numbers and must not be relabelled as
// unknown — the exhausted-allowance path recovers real spend from the error payload.
test("a failure that reported its spend is not turned into an unknown", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "quota-exhausted");
  const pluginDataDir = makeTempDir();
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir });

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", makeTempDir(), "burn it"],
    { env }
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "quota-exhausted");
  assert.equal(payload.costTicks, 3_662_428_000, "the recovered spend must survive");
  assert.equal(payload.usageIncomplete, false, "spend is known here, so it is not an unknown");
});
