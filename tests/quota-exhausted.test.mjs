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

// cli-1.0.45 notification.rs:364-391 attaches this projection at the top level of a fatal
// error (headless.rs:351-359). input_tokens there is uncached: 541541 - 443136 = 98405.
// cost_is_partial omits the ticks. promptUsage in the message is the cache-inclusive bill.
const HEADLESS_PROJECTION = JSON.stringify({
  type: "error",
  message:
    'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402,\n  "promptUsage": {\n    "inputTokens": 541541,\n    "outputTokens": 6082,\n    "totalTokens": 547623,\n    "cachedReadTokens": 443136,\n    "reasoningTokens": 5560,\n    "costUsdTicks": 3662428000,\n    "numTurns": 10\n  }\n}',
  usage: {
    input_tokens: 98405,
    output_tokens: 6082,
    reasoning_tokens: 5560,
    cache_read_input_tokens: 443136,
    cache_creation_input_tokens: 0,
    total_tokens: 547623
  },
  num_turns: 10,
  cost_is_partial: true
});

test("a fatal error prefers the headless projection over promptUsage", () => {
  const parsed = parseCliErrorPayload(HEADLESS_PROJECTION);

  assert.equal(parsed.usage.input_tokens, 98405, "uncached headless input, not the cache-inclusive promptUsage figure");
  assert.equal(parsed.usage.cache_read_input_tokens, 443136);
  assert.equal(parsed.numTurns, 10);
  assert.equal(parsed.costTicks, null, "cost_is_partial omits the ticks; promptUsage must not put them back");
  assert.equal(parsed.usageIncomplete, true);
  assert.equal(parsed.quotaExhausted, true);
});

test("promptUsage incomplete flags count when no headless projection is attached", () => {
  const payload = JSON.stringify({
    type: "error",
    message: JSON.stringify({
      message: "API error (status 500): upstream failure",
      http_status: 500,
      promptUsage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        costUsdTicks: 100,
        numTurns: 1,
        usageIsIncomplete: true
      }
    })
  });
  const parsed = parseCliErrorPayload(payload);
  assert.equal(parsed.quotaExhausted, false);
  assert.equal(parsed.usage.input_tokens, 12);
  assert.equal(parsed.usageIncomplete, true);
  assert.equal(parsed.costTicks, 100);

  const partialCost = JSON.stringify({
    type: "error",
    message: JSON.stringify({
      message: "API error (status 500): upstream failure",
      http_status: 500,
      promptUsage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, numTurns: 1, costIsPartial: true }
    })
  });
  assert.equal(parseCliErrorPayload(partialCost).usageIncomplete, true);
});

// error.rs:29 and :33. The apostrophe is U+2019, the character the CLI interpolates.
const FREE_USAGE_USER_MESSAGE =
  "You\u2019ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build";

test("free-usage exhaustion and a 403 credit refusal are quota, and nearby shapes are not", () => {
  const rewritten = parseCliErrorPayload(JSON.stringify({ type: "error", message: FREE_USAGE_USER_MESSAGE }));
  assert.equal(rewritten.quotaExhausted, true);
  assert.equal(rewritten.httpStatus, null);

  const coded = parseCliErrorPayload(JSON.stringify({
    type: "error",
    message: "subscription:free-usage-exhausted: rate limit"
  }));
  assert.equal(coded.quotaExhausted, true);

  const credits = parseCliErrorPayload(JSON.stringify({
    type: "error",
    message: JSON.stringify({
      message: "API error (status 403 Forbidden): You have run out of credits",
      http_status: 403
    })
  }));
  assert.equal(credits.quotaExhausted, true);
  assert.equal(credits.httpStatus, 403);

  const other403 = parseCliErrorPayload(JSON.stringify({
    type: "error",
    message: JSON.stringify({ message: "API error (status 403 Forbidden): content policy", http_status: 403 })
  }));
  assert.equal(other403.quotaExhausted, false);

  // billing.rs also matches the words "status 403" with no numeric field. This bridge
  // does not: the numeric http_status is required.
  assert.notEqual(
    parseCliErrorPayload(JSON.stringify({
      type: "error",
      message: "API error (status 403): you have run out of credits"
    }))?.quotaExhausted,
    true
  );
  assert.equal(parseCliErrorPayload("the task says we run out of credits"), null);
});

// One case per term of the quotaExhausted test in parseCliErrorPayload, each payload carrying
// ONLY that signal. The captured 402 carries three of them at once (status 402, and "balance
// exhausted" in both messages), so any one of those terms could be deleted without a test
// noticing.
function detailPayload(detailJsonText, outerPrefix = "Internal error: ") {
  return JSON.stringify({ type: "error", message: `${outerPrefix}${detailJsonText}` });
}

test("a 402 is quota-exhausted on its status alone", () => {
  const parsed = parseCliErrorPayload(
    detailPayload('{"message": "API error (status 402 Payment Required): payment is due", "http_status": 402}')
  );
  assert.equal(parsed?.httpStatus, 402);
  assert.doesNotMatch(parsed?.message ?? "", /balance exhausted/i);
  assert.equal(parsed?.quotaExhausted, true);
});

test("balance exhausted in the outer message alone is quota-exhausted", () => {
  const parsed = parseCliErrorPayload(
    detailPayload(
      '{"message": "API error (status 500): upstream failure", "http_status": 500}',
      "Grok Build usage balance exhausted. Internal error: "
    )
  );
  assert.equal(parsed?.httpStatus, 500);
  assert.doesNotMatch(parsed?.message ?? "", /balance exhausted/i);
  assert.equal(parsed?.quotaExhausted, true);
});

test("balance exhausted in the detail message alone is quota-exhausted", () => {
  // The detail JSON sits inside the outer message as raw text, so the outer test would match
  // a plain "balance exhausted" there too. The   escape keeps the raw outer text from
  // matching while the parsed detail message still reads "balance exhausted".
  const parsed = parseCliErrorPayload(
    detailPayload('{"message": "API error (status 500): balance\\u0020exhausted", "http_status": 500}')
  );
  assert.equal(parsed?.httpStatus, 500);
  assert.match(parsed?.message ?? "", /balance exhausted/i);
  assert.equal(parsed?.quotaExhausted, true);
});

test("the free-usage sentence as the detail message alone is quota-exhausted", () => {
  const parsed = parseCliErrorPayload(
    detailPayload(JSON.stringify({ message: FREE_USAGE_USER_MESSAGE, http_status: 500 }))
  );
  assert.equal(parsed?.httpStatus, 500);
  assert.equal(parsed?.message, FREE_USAGE_USER_MESSAGE);
  assert.equal(parsed?.quotaExhausted, true);
});

test("a success envelope with cost_is_partial is incomplete, and the projection reaches the caller", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "cost-partial");
  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", makeTempDir(), "price this"],
    { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() }) }
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(result.status, 0);
  assert.equal(payload.delivered, true);
  assert.equal(payload.usageIncomplete, true);
  assert.equal(payload.usage.input_tokens, 100);
  assert.equal(payload.costTicks, null);

  const bin2 = makeTempDir();
  installFakeGrok(bin2, "error-headless-projection");
  const refused = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", makeTempDir(), "refused"],
    { env: buildEnv(bin2, { CLAUDE_PLUGIN_DATA: makeTempDir() }) }
  );
  const refusedPayload = JSON.parse(refused.stdout);
  assert.equal(refusedPayload.failureCode, "quota-exhausted");
  assert.equal(refusedPayload.usage.input_tokens, 98405);
  assert.equal(refusedPayload.usageIncomplete, true);
  assert.equal(refusedPayload.costTicks, null);
  assert.equal(refused.status, 2);
});

test("free-usage exhaustion and the 403 credit refusal exit 2 as quota-exhausted", () => {
  for (const scenario of ["free-usage-exhausted", "credits-403"]) {
    const binDir = makeTempDir();
    installFakeGrok(binDir, scenario);
    const result = run(
      process.execPath,
      [SCRIPT, "run", "--json", "--cwd", makeTempDir(), "anything"],
      { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() }) }
    );
    assert.equal(result.status, 2, scenario);
    assert.equal(JSON.parse(result.stdout).failureCode, "quota-exhausted", scenario);
  }
});

// The headline names no status (a 402,
// a 403 and free-usage exhaustion share it), so the progress line written at classification
// time, which becomes the job record's lastMessage, is the only place a 403 credit refusal is
// told apart from a 402.
test("the last progress line of a 403 credit refusal names HTTP 403", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "credits-403");
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", workspace, "anything"],
    { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir }) }
  );
  assert.equal(JSON.parse(result.stdout).failureCode, "quota-exhausted");

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1, "the run must have been recorded");
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobs[0].id), "utf8"));
    assert.match(stored.lastMessage, /\(HTTP 403\)/);
    assert.match(stored.lastMessage, /usage balance is exhausted/);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
