import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { parseCliErrorPayload } from "../plugins/grok-build/scripts/lib/grok.mjs";
import {
  renderNativeReviewResult,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/grok-build/scripts/lib/render.mjs";
import { listJobs, resolveJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

/**
 * Observed 2026-08-02 against a real exhausted allowance, not constructed from the docs.
 *
 * The classification worked — `failureCode: "quota-exhausted"` was correct — but every
 * human-facing field said something else. `lastMessage` was "Grok exited with status 1",
 * and the rendered output was the raw CLI envelope, opening with the words "Internal
 * error". A spent allowance therefore presented as a bug in this plugin, which is the
 * precise failure this fork exists to prevent and the opposite of what the README
 * promises.
 *
 * ⚠ The first version of this file tested only `parseCliErrorPayload` — the one part of
 * the chain that was already working. A release review put it plainly: tests that
 * re-prove the classifier while the diagnosis names `rendered` and `summary` do not make
 * the fix safer, they make it look finished. The surface assertions below are the ones
 * that would have failed before the fix, and they assert POSITION: `/quota/` matched the
 * old output too, because the word was inside the envelope a few hundred characters down.
 */
const REAL_402 = JSON.stringify({
  type: "error",
  message:
    'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402,\n  "promptUsage": {\n    "inputTokens": 126099,\n    "outputTokens": 2750,\n    "totalTokens": 128849,\n    "cachedReadTokens": 87040,\n    "reasoningTokens": 1703,\n    "numTurns": 1,\n    "costUsdTicks": 2557300000\n  }\n}'
});

/**
 * Drive the real bridge against a scripted CLI and hand back what a person would see:
 * the JSON payload, and the job record `runs` and `show` read their text out of.
 */
function runScenario(scenario, prompt) {
  const binDir = makeTempDir();
  installFakeGrok(binDir, scenario);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--json", "--cwd", workspace, prompt],
    { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir }) }
  );

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1, "the run must have been recorded");
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobs[0].id), "utf8"));
    return { result, payload: JSON.parse(result.stdout), stored };
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0) ?? "";
}

// --- the surfaces a person actually reads ---

test("the first line of a spent allowance names the allowance, not an internal error", () => {
  const { stored, payload } = runScenario("quota-exhausted", "burn the last of the allowance");

  assert.equal(payload.failureCode, "quota-exhausted");

  const lead = firstLine(stored.rendered);
  assert.match(lead, /quota|402/i, `the opening line must name the cause, got: ${lead}`);
  // The three spellings of the old defect. Each one was the actual first line at some
  // point in this chain, and each reads as a fault in the bridge rather than in billing.
  assert.doesNotMatch(lead, /internal error/i, "an envelope must not open the output");
  assert.doesNotMatch(lead, /^[[{]"?type/i, "raw JSON must not open the output");
  assert.doesNotMatch(lead, /exited with status/i, "the exit code is not a cause");
});

test("the envelope is demoted, not discarded", () => {
  const { stored } = runScenario("quota-exhausted", "burn the last of the allowance");

  // Leading with the cause must not cost the reader the evidence: the CLI's own text is
  // the only place the HTTP status and the billed token counts survive, and a bug report
  // pasted from this output has to still contain them.
  assert.match(stored.rendered, /Internal error/, "the raw envelope must still be present");
  assert.match(stored.rendered, /balance exhausted/, "the CLI's own wording must survive");
  assert.match(stored.rendered, /Details:/, "the specific message keeps its own line");
});

test("the summary a finished run is listed under names the cause", () => {
  const { stored } = runScenario("quota-exhausted", "burn the last of the allowance");

  // `pushJobDetails` prints `Summary:` for every terminal job, so this is the sentence
  // that appears in `runs` and in `show`. It used to be firstMeaningfulLine(rawOutput),
  // i.e. the envelope's opening line.
  assert.match(stored.summary, /quota|402/i);
  assert.doesNotMatch(stored.summary, /internal error/i);
  assert.doesNotMatch(stored.summary, /^[[{]/, "the summary must not be a JSON fragment");
});

test("the last progress line names the cause once the cause is known", () => {
  const { stored } = runScenario("quota-exhausted", "burn the last of the allowance");

  // Emitted after classification, replacing the pre-classification line that could only
  // report an exit code. This is the `Last:` field, and the only one the earlier version
  // of this fix actually repaired.
  assert.match(stored.lastMessage, /exhausted|402/i);
  assert.doesNotMatch(stored.lastMessage, /exited with status/i);
});

// --- the general case: the complaint was never only about 402 ---

test("a failure outside the retry-cannot-help pair also names itself", () => {
  // `cli-error` is the common failure and is in neither RETRY_CANNOT_HELP nor the second
  // progress line. Before the shared headline table it summarised itself with the exit
  // status — the exact useless sentence the quota fix was written to remove, still being
  // printed for every other kind of failure.
  const { stored, payload } = runScenario("fail-print", "fail this run");

  assert.equal(payload.failureCode, "cli-error");
  assert.match(firstLine(stored.rendered), /Grok CLI failed/i);
  assert.match(stored.summary, /Grok CLI failed/i);
  assert.doesNotMatch(stored.summary, /exited with status/i);
  // and the CLI's own stderr is still carried, one line down
  assert.match(stored.rendered, /fake grok failed the print run/);
});

test("a signed-out run says how to sign in", () => {
  const { stored, payload } = runScenario("not-signed-in", "anything at all");

  assert.equal(payload.failureCode, "not-authenticated");
  assert.match(firstLine(stored.rendered), /signed in/i);
  assert.match(stored.summary, /grok login --device-code|XAI_API_KEY/);
});

test("a run that succeeds is not decorated with a failure it did not have", () => {
  // The guard on the change: `runFailed` gates the headline, and a false positive there
  // would stamp "Run did not succeed" on every good run.
  const { stored, payload } = runScenario("default", "do something ordinary");

  assert.equal(payload.failureCode, null);
  assert.equal(payload.delivered, true);
  assert.doesNotMatch(stored.rendered, /Run did not succeed/);
  assert.doesNotMatch(stored.summary ?? "", /Run did not succeed/);
});

// --- the other three surfaces that state a cause ---
//
// Added after a re-gate review found the first pass had generalised the fix to the task path
// and stopped there: critique still summarised an auth failure as its exit status, a failed
// native review led with the exit status and buried the sign-in remedy under "Partial
// output", and `show` re-assembles from the stored record rather than replaying `rendered`,
// so it had none of the repair. Same defect, three more places.

test("a failed critique is listed under its cause, not its exit status", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  // Auth is the sharp case: `failureDetail` is null there, so `failureMessage` falls all the
  // way through to "Grok exited with status 1".
  installFakeGrok(binDir, "not-signed-in");

  const result = run(process.execPath, [SCRIPT, "critique", "--json"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
  });
  assert.equal(JSON.parse(result.stdout).failureCode, "not-authenticated");

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, jobs[0].id), "utf8"));
    assert.match(stored.summary, /signed in/i);
    assert.doesNotMatch(stored.summary, /exited with status/i);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("a failed native review leads with the cause, not the exit status", () => {
  // The caller had always passed failureCode here and the renderer never read it.
  const output = renderNativeReviewResult(
    {
      status: 1,
      exitStatus: 2,
      stdout: '{"type":"error","message":"Not signed in. To authenticate ..."}',
      stderr: "",
      failureMessage: "Grok exited with status 1.",
      failureCode: "not-authenticated"
    },
    { reviewLabel: "Review", targetLabel: "worktree" }
  );

  const body = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  // line 0 is the "# Grok Build Review" heading, line 1 the target
  const lead = body[2] ?? "";
  assert.match(lead, /signed in/i, `expected the cause on the lead line, got: ${lead}`);
  assert.doesNotMatch(lead, /exited with status/i);
  // the CLI's own text is still there, below
  assert.match(output, /Partial output/);
});

test("show names the cause before the envelope it prints", () => {
  const output = renderStoredJobResult(
    {
      id: "job-quota-1",
      status: "failed",
      title: "Grok Build Delegate",
      failureCode: "quota-exhausted",
      errorMessage: "Grok exited with status 1."
    },
    {
      status: "failed",
      result: {
        rawOutput: '{"type":"error","message":"Internal error: {\\"http_status\\": 402}"}',
        failureCode: "quota-exhausted",
        delivered: false
      }
    }
  );

  // ⚠ Match a phrase only the headline can produce. The first version of this assertion
  // used /quota|402/ and passed before the fix, because `Failure code: quota-exhausted` is
  // printed above the envelope and contains the word — the test was reading a machine field
  // and calling it a sentence. That is the same mistake the whole commit is about.
  const causeAt = output.search(/refused the run for quota reasons/i);
  const envelopeAt = output.indexOf("Internal error");
  const exitStatusAt = output.search(/exited with status/i);
  assert.notEqual(causeAt, -1, "show must name the cause in words, not only as a code");
  assert.notEqual(envelopeAt, -1, "show must still carry the evidence");
  assert.ok(causeAt < envelopeAt, "the cause must appear before the raw envelope");
  assert.ok(
    exitStatusAt === -1 || causeAt < exitStatusAt,
    "the cause must precede the exit status, which is a detail rather than a reason"
  );
  assert.match(output, /Partial output/, "the envelope stays labelled as partial");
});

// --- a cause is not its own evidence ---
//
// The cost of leading with a headline: for two of the seven codes the CLI's own message is
// word-for-word the table sentence, so the "Details:" line repeated it. Found by the third
// release gate, and it was introduced by the fix for the second one.

test("a cause that is its own detail is not printed twice", () => {
  const output = renderTaskResult(
    { rawOutput: "", failureMessage: "Grok returned no output.", warnings: [] },
    { failureCode: "no-deliverable" }
  );
  const times = output.split("Grok returned no output.").length - 1;
  assert.equal(times, 1, `expected the cause once, got ${times}:\n${output}`);
});

test("a detail that adds something is still shown", () => {
  // The guard must not swallow a genuinely different message - the nudged variant says
  // something the headline does not, namely that a retry was already attempted.
  const output = renderTaskResult(
    {
      rawOutput: "",
      failureMessage: "Grok returned no output, even after an automatic retry.",
      warnings: []
    },
    { failureCode: "no-deliverable" }
  );
  assert.match(output, /Details:/);
  assert.match(output, /even after an automatic retry/);
});

test("show does not repeat the cause when there is no envelope to show", () => {
  const output = renderStoredJobResult(
    {
      id: "job-empty-1",
      status: "failed",
      title: "Grok Build Delegate",
      failureCode: "no-deliverable"
    },
    {
      status: "failed",
      rendered: "[grok-cc] Run did not succeed: Grok returned no output.\n",
      result: { rawOutput: "", failureCode: "no-deliverable", delivered: false }
    }
  );

  const times = output.split("Grok returned no output.").length - 1;
  assert.equal(times, 1, `expected the cause once, got ${times}:\n${output}`);
  assert.doesNotMatch(output, /Partial output/, "there is no partial output to label");
});

// --- the classifier underneath, which was already correct ---

test("an exhausted allowance is recognised, with the work it already paid for", () => {
  const parsed = parseCliErrorPayload(REAL_402);

  assert.ok(parsed, "the 402 payload must be recognised");
  assert.equal(parsed.quotaExhausted, true);
  assert.equal(parsed.httpStatus, 402);
  // The refused attempt is not free: the prompt was assembled and sent before the refusal
  // came back, so a cached read of this size was genuinely billed. Booking it as zero
  // would understate a period exactly when spending matters most.
  assert.equal(parsed.costTicks, 2_557_300_000);
  assert.equal(parsed.usage.cache_read_input_tokens, 87_040);
  assert.equal(parsed.usage.total_tokens, 128_849);
});

test("the turn count survives the failure path", () => {
  // It did not, until 2026-08-02. `numTurns` was read only from a success envelope, and a
  // fatal error produces none — so the CLI reported the count twice in the same payload
  // and the job record still said null. Turn count is the live diagnostic for whether a
  // run did any work before it stopped, which makes a failure the worst place to lose it.
  const parsed = parseCliErrorPayload(REAL_402);
  assert.equal(parsed.numTurns, 1);
});

test("the turn count is read from either spelling on the outer payload", () => {
  // The captured fixtures all carry `promptUsage.numTurns`, so the outer fallbacks were
  // never exercised by a real capture. snake_case was handled; camelCase was not, and
  // would have stored null with the count sitting in the payload.
  const camel = JSON.stringify({
    type: "error",
    message:
      'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402,\n  "numTurns": 4\n}'
  });
  assert.equal(parseCliErrorPayload(camel).numTurns, 4);

  const snake = JSON.stringify({
    type: "error",
    message:
      'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402,\n  "num_turns": 7\n}'
  });
  assert.equal(parseCliErrorPayload(snake).numTurns, 7);
});

test("a payload with no usage block still classifies, without inventing numbers", () => {
  const bare = JSON.stringify({
    type: "error",
    message:
      'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}'
  });
  const parsed = parseCliErrorPayload(bare);

  assert.ok(parsed);
  assert.equal(parsed.quotaExhausted, true);
  assert.equal(parsed.usage, null, "absent usage stays absent rather than becoming zero");
  assert.equal(parsed.costTicks, null, "unknown cost is null, which the ledger reads as unmeasured");
  assert.equal(parsed.numTurns, null);
});
