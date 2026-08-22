/**
 * When a read-only run exits 0 with no deliverable, the bridge resumes the session once. That
 * is two CLI launches, and the record used to carry one launch's spend.
 *
 * The retry's result replaced the first wholesale — everything except `structuredOutput`, which
 * had its own carve-out — so the first attempt's `usage`, `costTicks` and `numTurns` were
 * discarded. `usageIncomplete` stayed false, because the retry DID carry usage and nothing
 * asked whether anything was missing. The ledger then summed a confident, wrong number, and
 * there is no quota endpoint anywhere to reconcile it against: this record is the only view of
 * what a run cost.
 *
 * ⚠ It undercounts hardest where it matters most. The nudge fires when a turn was spent and no
 * text came back — which is exactly what exhausting `--max-turns` produces. The most expensive
 * failures were the most under-reported.
 *
 * Measured 2026-08-09 before the fix: 2 launches, `usage` 10/5/15, `numTurns` 2,
 * `usageIncomplete` false. Found by an architectural review of the whole project, not by the
 * tests — which counted the launches and never looked at what was recorded for them.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeGrok, buildEnv } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const SCRIPT = path.resolve("plugins/grok-build/scripts/grok-bridge.mjs");

function nudgedRun(scenario) {
  const binDir = makeTempDir();
  installFakeGrok(binDir, scenario);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, GROK_FAKE_ARGV_LOG: argvLog });

  const result = run(process.execPath, [SCRIPT, "run", "--json", "--cwd", workspace, "say nothing"], { env });
  const launches = fs.existsSync(argvLog)
    ? fs.readFileSync(argvLog, "utf8").split("\n").filter((l) => l.trim()).length
    : 0;
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  return { payload, launches, result };
}

test("a nudged run records the spend of BOTH launches", () => {
  const { payload, launches } = nudgedRun("empty-then-ok");

  assert.ok(payload, "expected a --json payload");
  assert.equal(launches, 2, "the fixture must actually nudge, or this test proves nothing");
  assert.equal(payload.nudged, true);

  // The fixture emits 10/5/15 per launch. One launch's worth means the first was discarded.
  // ⚠ The --json payload is FLAT. `numTurns`, `usage` and `nudged` sit at the top level here;
  // the stored JOB RECORD nests them under `result`, which is a different shape entirely and
  // is what an earlier version of this test reached for.
  const usage = payload.usage;
  assert.ok(usage, "usage must be recorded");
  assert.equal(
    usage.total_tokens,
    30,
    `two launches at 15 tokens each must record 30, got ${usage.total_tokens} — the first attempt was dropped`
  );
  assert.equal(usage.input_tokens, 20);
  assert.equal(usage.output_tokens, 10);

  // Turns are the other half of the same fact: a reader uses them to judge whether a run did
  // what it cost.
  assert.equal(payload.numTurns, 4, "both launches' turns must be counted");

  // And because both attempts reported usage, the total is genuinely complete — this must NOT
  // become "mark everything incomplete", which would trade a wrong number for a useless one.
  assert.equal(payload.usageIncomplete, false, "both launches were measured, so this is complete");
});
