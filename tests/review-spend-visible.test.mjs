/**
 * A successful review has to show up in the spend ledger.
 *
 * It did not. `review` (everything except Critique) was launched with
 * `--output-format plain`, so the CLI produced no envelope, so `result.usage` was always
 * null — and the ledger's "skip a record with no usage, no cost and no ticks" rule dropped
 * every one of them. Not marked incomplete, not counted as zero: absent. Every review
 * anyone had ever run was missing from the spend history, and a week of calibrating
 * dollars against the subscription percentage had been built on what was left.
 *
 * Found on 2026-07-31 by a review pass that was asked only about silent failures, and confirmed
 * by an independent reviewer that read the whole chain. The fix is one word — the output
 * format — because `parseCliEnvelope` already falls back to raw stdout when the output is
 * not an envelope, which is exactly what `plain` did.
 *
 * The pair is deliberately split, and an independent verification corrected how this was
 * first described: the second test is the ledger one, the first is a payload assertion.
 * Both are needed and neither alone would do. Test 2 asks the question that matters — does
 * the run become visible to `usage` — but `runs > 0` would also be satisfied by a record
 * carrying nothing but an incomplete marker. Test 1 closes that by requiring real token
 * numbers in the payload the ledger reads from. Claiming the pair was "about the ledger,
 * not the payload" was tidier than it was true.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");
const HARNESS_MS = 90000;

function reviewableRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "subject.txt"), "something to review\n", "utf8");
  return repo;
}

test("a successful review reports usage, so the ledger can see it", () => {
  const repo = reviewableRepo();
  const binDir = makeTempDir();
  const pluginData = makeTempDir();
  installFakeGrok(binDir, "default");

  const result = run(process.execPath, [SCRIPT, "review", "--json"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginData }),
    timeout: HARNESS_MS
  });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(
    payload.usage && typeof payload.usage === "object",
    "a delivered review must carry the CLI's usage; without it the run is invisible to `usage`"
  );
  assert.ok(
    Number(payload.usage.total_tokens ?? payload.usage.totalTokens ?? 0) > 0,
    "usage has to carry actual numbers, not an empty object"
  );
});

test("the review then appears in `usage`, not just in its own payload", () => {
  const repo = reviewableRepo();
  const binDir = makeTempDir();
  const pluginData = makeTempDir();
  installFakeGrok(binDir, "default");
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginData });

  const review = run(process.execPath, [SCRIPT, "review", "--json"], {
    cwd: repo,
    env,
    timeout: HARNESS_MS
  });
  assert.equal(review.status, 0, review.stderr + review.stdout);

  // The fixture workspace is excluded from the ledger by name, so ask for it explicitly.
  const usage = run(
    process.execPath,
    [SCRIPT, "usage", "--json", "--days", "7", "--include-test-workspaces"],
    { cwd: repo, env, timeout: HARNESS_MS }
  );
  assert.equal(usage.status, 0, usage.stderr + usage.stdout);

  const report = JSON.parse(usage.stdout);
  assert.ok(
    report.runs > 0,
    `the review must be counted; the ledger reported ${report.runs} runs — ` +
      "a review that costs money and shows up nowhere is the defect this pins"
  );
});
