import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { parseCliErrorPayload } from "../plugins/grok-build/scripts/lib/grok.mjs";
import { listJobs, resolveJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

// A real 402 envelope, captured verbatim on 2026-07-27 rather than hand-written, because
// the shape is the thing under test: the usage block is nested inside a JSON string inside
// the `message` field, and a fixture invented from the documentation would have got that
// wrong in exactly the way the parser used to. The numbers below are that capture; they
// are a test vector, not a statement about anyone's account.
const REAL_402 = JSON.stringify({
  type: "error",
  message:
    'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402,\n  "promptUsage": {\n    "inputTokens": 541541,\n    "outputTokens": 6082,\n    "totalTokens": 547623,\n    "cachedReadTokens": 443136,\n    "reasoningTokens": 5560,\n    "modelCalls": 10,\n    "apiDurationMs": 91662,\n    "costUsdTicks": 3662428000,\n    "numTurns": 10\n  }\n}'
});

test("an exhausted allowance is recognised as its own failure, not a generic CLI error", () => {
  const parsed = parseCliErrorPayload(REAL_402);

  assert.ok(parsed, "the error payload must be recognised");
  assert.equal(parsed.quotaExhausted, true);
  assert.equal(parsed.httpStatus, 402);
  assert.match(parsed.message, /balance exhausted/i);
});

test("the work already paid for is recovered from the failure", () => {
  const parsed = parseCliErrorPayload(REAL_402);

  // The run delivered nothing and was still billed. Counting it as free would understate
  // what a period actually consumed, which is the whole point of the ledger.
  assert.equal(parsed.costTicks, 3_662_428_000);
  assert.equal(parsed.usage.total_tokens, 547_623);
  assert.equal(parsed.usage.input_tokens, 541_541);
  assert.equal(parsed.usage.cache_read_input_tokens, 443_136);
});

test("other CLI failures are not mistaken for an exhausted allowance", () => {
  const otherError = JSON.stringify({
    type: "error",
    message:
      'Internal error: {\n  "message": "API error (status 500): upstream failure",\n  "http_status": 500\n}'
  });

  const parsed = parseCliErrorPayload(otherError);
  assert.equal(parsed.quotaExhausted, false, "a 500 is retryable and must stay a plain cli-error");
  assert.equal(parsed.httpStatus, 500);
});

test("ordinary output is not mistaken for an error payload", () => {
  assert.equal(parseCliErrorPayload(""), null);
  assert.equal(parseCliErrorPayload("Here is my review of the code."), null);
  assert.equal(parseCliErrorPayload('{"type":"result","text":"all good"}'), null);
});

// Recognising the error is only half of it. The recovered spend has to survive the whole
// chain — run result, JSON payload, job record — or the ledger still reports the run as
// free. Testing only the parser is how a fix looks done while changing nothing.
test("the failure class and the recovered spend reach the caller and the job record", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "quota-exhausted");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir });

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", workspace, "burn the last of the allowance"],
    { env }
  );

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "quota-exhausted", "a caller must be able to tell not-worth-retrying");
  assert.equal(payload.delivered, false);
  assert.equal(payload.costTicks, 3_662_428_000, "the spend must survive into the payload");
  assert.equal(payload.usage.total_tokens, 547_623);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1, "the run must have been recorded");
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobs[0].id), "utf8"));
    assert.equal(stored.costTicks, 3_662_428_000, "and must reach the record the ledger reads");
    assert.equal(stored.usage.total_tokens, 547_623);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

// Two loose ends from introducing the failure class: the rendered text still fell through
// to "did not return valid structured JSON", and the process exited 1 while the README
// promised 2. Both were found by a later review pass, not by the tests that shipped with
// the class — a new failure code has to be walked through every surface that names one.
test("the exit code matches the documented contract for an exhausted allowance", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "quota-exhausted");
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() });

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", makeTempDir(), "anything"],
    { env }
  );

  assert.equal(result.status, 2, "exit 2 is what the README's failure table promises");
  assert.equal(JSON.parse(result.stdout).failureCode, "quota-exhausted");
});

test("a critique blames the billing refusal, not the model's JSON", async () => {
  const { renderReviewResult } = await import("../plugins/grok-build/scripts/lib/render.mjs");

  const rendered = renderReviewResult(
    { parsed: null, parseError: "Grok did not return valid structured JSON.", rawOutput: "" },
    {
      reviewLabel: "Critique",
      targetLabel: "worktree",
      failureCode: "quota-exhausted",
      failureMessage: "Grok Build usage balance exhausted"
    }
  );

  // Matches "quota" rather than "allowance is used up". The headline was reworded once it
  // turned out not every account HAS an allowance: a plan has one and it resets, an API key
  // has credit that can be topped up, and an account permitted to fall through to metered
  // tokens may not stop at all. What this assertion protects is unchanged — the reader must
  // be told this was a billing refusal, and must not be blamed for the model's JSON, which
  // is the defect the test was written for.
  assert.match(rendered, /quota/i);
  assert.doesNotMatch(rendered, /did not return valid structured JSON/i);
});
