// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Install a fake `grok` binary that responds to version/models/-p/import for hermetic tests.
 * @param {string} binDir directory that will be prepended to PATH
 * @param {"default"|"not-logged-in"|"models-exit-zero-denied"|"models-api-key"|"models-own-api-key"|"models-deployment-key"|"not-signed-in"|"denied-exit-zero"|"auth-prose-answer"|"fail-print"|"import-ok"|"empty-text"|"empty-then-ok"|"non-json"|"multi-object-stream"|"bare-text-object"|"hang"|"stderr-progress"|"huge-output"|"huge-stderr"|"structured-output-only"|"structured-then-empty-nudge"|"invalid-review-shape"|"text-plus-usage-object"|"json-then-fail"|"json-then-hang"|"text-then-hang"|"max-turns"|"envelope-with-auth-hints"|"cost-partial"|"cost-partial-then-text"|"usage-no-cost-then-priced"|"error-headless-projection"|"free-usage-exhausted"|"credits-403"|"empty-no-usage-then-ok"} scenario
 */
export function installFakeGrok(binDir, scenario = "default") {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "grok");

  const source = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const scenario = ${JSON.stringify(scenario)};
const argv = process.argv.slice(2);

function hasFlag(name) {
  return argv.includes(name);
}

function flagValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

// Retained pruning rewrites the whole chat file after swapping aged tool results for this
// placeholder (cli-1.0.45 xai-chat-state actor/request_builder.rs:14, mutations.rs:385-388).
// Results of the last prior user turn stay; those are the ones younger than the threshold.
function rewritePrunedHistory(text) {
  const placeholder = "[Tool result omitted — too old]";
  const lines = String(text).split("\\n");
  const entries = lines.map((line) => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); } catch { return null; }
  });
  let lastUser = -1;
  entries.forEach((entry, index) => {
    if (entry && entry.type === "user") lastUser = index;
  });
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const entry = entries[i];
    if (entry && entry.type === "tool_result" && (lastUser === -1 || i < lastUser)) {
      entry.content = placeholder;
      out.push(JSON.stringify(entry));
    } else {
      out.push(lines[i]);
    }
  }
  return out.join("\\n") + "\\n";
}

function writeLog() {
  // Prefer GROK_FAKE_LOG: agent spawn sanitizes env and only forwards GROK_/XAI_/…
  const logPath = process.env.GROK_FAKE_LOG || process.env.FAKE_GROK_LOG;
  if (!logPath) return;
  // The two managed-connector switches are recorded so connector-mode tests can see what the
  // bridge put into the child's environment, not only onto its command line.
  const managedMcps = {
    GROK_MANAGED_MCPS_ENABLED: process.env.GROK_MANAGED_MCPS_ENABLED ?? null,
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: process.env.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED ?? null
  };
  // Whether the bridge marked this process as its own grok child.
  const bridgeChild = process.env.GROK_CC_BRIDGE_CHILD ?? null;
  // The memory switch the bridge put into this process's environment.
  const memory = process.env.GROK_MEMORY ?? null;
  fs.appendFileSync(logPath, JSON.stringify({ argv, scenario, cwd: process.cwd(), managedMcps, bridgeChild, memory }) + "\\n");
}

writeLog();

if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-V") {
  if (hasFlag("--json")) {
    process.stdout.write(JSON.stringify({ currentVersion: "0.2.83-fake", channel: "test" }) + "\\n");
  } else {
    process.stdout.write("grok 0.2.83-fake\\n");
  }
  process.exit(0);
}

if (argv[0] === "models") {
  if (scenario === "not-logged-in") {
    process.stderr.write("Not logged in. Run grok interactively to authenticate.\\n");
    process.exit(1);
  }
  if (scenario === "models-exit-zero-denied") {
    // Observed on a Windows machine, 2026-07-31: inside an OIDC token refresh the CLI
    // answers the models probe with a denial on STDOUT and still exits 0. Note the single
    // hint — this string is why the probe cannot use the general two-hint threshold.
    process.stdout.write("You are not authenticated.\\n");
    process.exit(0);
  }
  // cli-1.0.45 xai-grok-pager/src/models.rs:12-17. The OAuth line is the default below.
  if (scenario === "models-api-key") {
    process.stdout.write("You are using XAI_API_KEY.\\n\\nDefault model: fake-model\\n");
    process.exit(0);
  }
  if (scenario === "models-own-api-key") {
    process.stdout.write("Model 'fake-model' is using its own API key.\\n");
    process.exit(0);
  }
  if (scenario === "models-deployment-key") {
    process.stdout.write("You are authenticated via deployment key.\\n");
    process.exit(0);
  }
  process.stdout.write("You are logged in with grok.com.\\n\\nDefault model: fake-model\\n\\nAvailable models:\\n  - fake-model\\n");
  process.exit(0);
}

if (argv[0] === "import") {
  if (hasFlag("--list")) {
    if (hasFlag("--json")) {
      process.stdout.write(JSON.stringify({ sessions: [] }) + "\\n");
    } else {
      process.stdout.write("No sessions listed.\\n");
    }
    process.exit(0);
  }
  const target = argv.find((arg, i) => i > 0 && !arg.startsWith("-")) ?? "unknown";
  const sessionId = "11111111-2222-4333-8444-555555555555";
  if (hasFlag("--json")) {
    process.stdout.write(JSON.stringify({ sessionId, source: target, status: "imported" }) + "\\n");
  } else {
    process.stdout.write("Imported session " + sessionId + " from " + target + "\\n");
  }
  process.exit(0);
}

// Headless print / prompt modes
const printIndex = argv.indexOf("-p");
// Lets tests assert on the exact argv the bridge produced (e.g. the read-only barrier).
if (process.env.GROK_FAKE_ARGV_LOG) {
  try {
    fs.appendFileSync(process.env.GROK_FAKE_ARGV_LOG, JSON.stringify(argv) + "\\n", "utf8");
  } catch {}
}

const isPrint = printIndex !== -1 || hasFlag("--print") || hasFlag("--prompt-file");
const isHeadless =
  isPrint || hasFlag("-r") || hasFlag("--resume") || hasFlag("-c") || hasFlag("--continue");

// ESM forbids top-level return. Hang scenarios must never reach process.exit below.
const reviewApproveBody = {
  verdict: "approve",
  summary: "No material issues found in the reviewed changes.",
  findings: [],
  next_steps: ["Ship it."]
};

function writeStructuredReviewThen(exitOrHang) {
  const sessionId = flagValue("--session-id") || "fake-session-structured";
  if (flagValue("--output-format") === "json") {
    process.stdout.write(
      JSON.stringify({
        text: JSON.stringify(reviewApproveBody),
        stopReason: "EndTurn",
        sessionId,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        structuredOutput: reviewApproveBody
      }) + "\\n"
    );
  } else {
    process.stdout.write(JSON.stringify(reviewApproveBody) + "\\n");
  }
  if (exitOrHang === "hang") {
    setInterval(() => {}, 1 << 30);
  } else {
    process.stderr.write("fake grok failed after emitting structured review\\n");
    process.exit(1);
  }
}

if (scenario === "hang" && isHeadless) {
  process.stderr.write("fake grok hanging for timeout tests\\n");
  setInterval(() => {}, 1 << 30);
} else if (scenario === "json-then-hang" && isHeadless) {
  writeStructuredReviewThen("hang");
} else if (scenario === "text-then-hang" && isHeadless) {
  process.stdout.write("Looks fine overall.\\nNo material issues found.\\n");
  setInterval(() => {}, 1 << 30);
} else if (isHeadless) {
  if (scenario === "stderr-progress") {
    process.stderr.write("searching: auth module\\n");
    process.stderr.write("running tool: Grep\\n");
  }
  if (scenario === "huge-stderr") {
    // One giant newline-free chunk so both the accumulated stderr string and the
    // line assembler are forced to bound growth.
    const size = Number.parseInt(process.env.GROK_FAKE_STDERR_BYTES ?? "20000", 10);
    process.stderr.write("E".repeat(Math.max(1, size)));
    process.stdout.write(
      JSON.stringify({
        text: "ok despite stderr flood",
        stopReason: "EndTurn",
        sessionId: "fake-session-stderr",
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }) + "\\n"
    );
    process.exit(0);
  }
  if (scenario === "fail-print") {
    process.stderr.write("fake grok failed the print run\\n");
    process.exit(2);
  }
  if (scenario === "quota-exhausted") {
    // Shape captured from a real allowance exhaustion on 2026-07-27 (same capture as
    // tests/quota-exhausted.test.mjs): the fatal error goes to stdout
    // with the detail JSON-encoded inside message, and it accounts for the work already
    // done before the refusal.
    var detail = {
      message: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
      http_status: 402,
      promptUsage: {
        inputTokens: 541541,
        outputTokens: 6082,
        totalTokens: 547623,
        cachedReadTokens: 443136,
        reasoningTokens: 5560,
        modelCalls: 10,
        costUsdTicks: 3662428000,
        numTurns: 10
      }
    };
    process.stdout.write(
      JSON.stringify({ type: "error", message: "Internal error: " + JSON.stringify(detail, null, 2) })
    );
    process.exit(1);
  }
  if (scenario === "free-usage-exhausted") {
    // The rewritten -32003 message. The apostrophe is U+2019.
    // cli-1.0.45 xai-grok-shell/src/sampling/error.rs:33, headless.rs:1413-1418.
    process.stdout.write(JSON.stringify({
      type: "error",
      message: "You\u2019ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build"
    }));
    process.exit(1);
  }
  if (scenario === "credits-403") {
    // http_status 403 plus the legacy credit wording. billing.rs:60-71.
    var credits = {
      message: "API error (status 403 Forbidden): You have run out of credits",
      http_status: 403
    };
    process.stdout.write(
      JSON.stringify({ type: "error", message: "Internal error: " + JSON.stringify(credits) })
    );
    process.exit(1);
  }
  if (scenario === "error-headless-projection") {
    // Top-level usage is the uncached headless projection (98405 = 541541 - 443136).
    // Ticks are omitted because cost_is_partial is set. notification.rs:364-391,
    // attached by headless.rs:351-359. promptUsage stays the cache-inclusive bill.
    var projectedDetail = {
      message: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
      http_status: 402,
      promptUsage: {
        inputTokens: 541541,
        outputTokens: 6082,
        totalTokens: 547623,
        cachedReadTokens: 443136,
        reasoningTokens: 5560,
        costUsdTicks: 3662428000,
        numTurns: 10
      }
    };
    process.stdout.write(JSON.stringify({
      type: "error",
      message: "Internal error: " + JSON.stringify(projectedDetail),
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
    }));
    process.exit(1);
  }
  if (scenario === "not-signed-in") {
    // Captured verbatim from grok 0.2.117 on an aarch64 host whose session had lapsed
    // (2026-07-31). Note the shape: the fatal error arrives as a JSON envelope on
    // STDOUT, not on stderr, and carries the remedy in its own message.
    process.stdout.write(
      JSON.stringify({
        type: "error",
        message:
          "Not signed in. To authenticate without a browser, run:\\n  grok login --device-code\\n\\n" +
          "Alternatively, set the XAI_API_KEY environment variable or run \`grok login\` on a machine with a browser."
      })
    );
    process.exit(1);
  }
  if (scenario === "denied-exit-zero") {
    // The signed-out envelope, but with exit 0 — the shape the models probe was actually
    // caught doing on 2026-07-31. Same binary, so the headless path is not immune.
    process.stdout.write(
      JSON.stringify({
        type: "error",
        message:
          "Not signed in. To authenticate without a browser, run:\\n  grok login --device-code\\n\\n" +
          "Alternatively, set the XAI_API_KEY environment variable or run \`grok login\` on a machine with a browser."
      })
    );
    process.exit(0);
  }
  if (scenario === "auth-prose-answer") {
    // A SUCCESSFUL review that legitimately discusses authentication. It carries several
    // of the same hints as a real denial and must still be delivered: the discriminator is
    // the CLI's own error envelope, not the words. This is the false-positive guard.
    process.stdout.write(
      "Reviewed the auth module.\\n" +
        "It rejects requests when the client is not signed in, and tells the caller to run\\n" +
        "\`grok login\` or set XAI_API_KEY. That path looks correct.\\n"
    );
    process.exit(0);
  }
  if (scenario === "answer-quotes-envelope") {
    // The self-inflicted case: a REVIEW OF THIS REPOSITORY. The fixture and the library
    // both contain the signed-out envelope verbatim, so any honest review of them quotes
    // it — envelope plus auth hints, inside a delivered answer. If the discriminator is
    // "an error envelope appears anywhere in stdout", reviewing this very repo through
    // the bridge fails as not-authenticated.
    process.stdout.write(
      "Reviewed the auth handling.\\n\\n" +
        "The CLI emits this on a lapsed session:\\n" +
        JSON.stringify({
          type: "error",
          message:
            "Not signed in. To authenticate without a browser, run:\\n  grok login --device-code\\n\\n" +
            "Alternatively, set the XAI_API_KEY environment variable."
        }) +
        "\\n\\nThe bridge classifies that correctly. No issues found.\\n"
    );
    process.exit(0);
  }
  if (scenario === "json-then-fail") {
    writeStructuredReviewThen("fail");
  }

  // Long prompts arrive as a file (the bridge keeps them off the command line).
  const promptFile = flagValue("--prompt-file");
  let prompt = printIndex !== -1 ? (argv[printIndex + 1] ?? "") : "";
  if (promptFile) {
    try {
      prompt = fs.readFileSync(promptFile, "utf8");
    } catch {}
  }
  const isResume = hasFlag("-r") || hasFlag("--resume");
  const sessionId = flagValue("--session-id") || flagValue("-r") || "fake-session-0001";

  if (scenario === "max-turns") {
    // headless.rs:1397-1406 writes the envelope; main.rs:2120-2128 prints the stderr
    // line and exits 1. The text mentions the auth hints on purpose.
    process.stdout.write(JSON.stringify({
      text: "Partial review so far. The notes say to run grok login and to set XAI_API_KEY, which is the model's own text.",
      stopReason: "cancelled",
      sessionId: sessionId,
      num_turns: 8,
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
    }) + "\\n");
    process.stderr.write("Error: max turns reached\\n");
    process.exit(1);
  }
  if (scenario === "envelope-with-auth-hints") {
    process.stdout.write(JSON.stringify({
      text: "Reviewed auth. Run grok login and set XAI_API_KEY. The module looks fine.",
      stopReason: "EndTurn",
      sessionId: sessionId,
      num_turns: 2,
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
    }) + "\\n");
    process.stderr.write("Error: upstream\\n");
    process.exit(1);
  }
  if (scenario === "cost-partial") {
    // notification.rs:377-392: cost_is_partial omits ticks and total_cost_usd.
    process.stdout.write(JSON.stringify({
      text: "Answer with a withheld cost.",
      stopReason: "EndTurn",
      sessionId: sessionId,
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      cost_is_partial: true
    }) + "\\n");
    process.exit(0);
  }
  if (scenario === "cost-partial-then-text") {
    if (isResume) {
      process.stdout.write(JSON.stringify({
        text: "Recovered after a partial first bill.",
        stopReason: "EndTurn",
        sessionId: sessionId,
        num_turns: 1,
        usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 }
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({
        text: "",
        stopReason: "EndTurn",
        sessionId: sessionId,
        num_turns: 1,
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        cost_is_partial: true
      }) + "\\n");
    }
    process.exit(0);
  }
  if (scenario === "empty-no-usage-then-ok") {
    // First turn is empty and the envelope carries no usage block at all; the resume returns
    // text with usage, so the nudge's spend must be marked incomplete.
    if (isResume) {
      process.stdout.write(JSON.stringify({
        text: "Recovered after an unmeasured empty turn.",
        stopReason: "EndTurn",
        sessionId: sessionId,
        num_turns: 1,
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({
        text: "",
        stopReason: "EndTurn",
        sessionId: sessionId,
        num_turns: 1
      }) + "\\n");
    }
    process.exit(0);
  }
  if (scenario === "usage-no-cost-then-priced") {
    if (isResume) {
      process.stdout.write(JSON.stringify({
        text: "Priced retry.",
        stopReason: "EndTurn",
        sessionId: sessionId,
        num_turns: 1,
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        total_cost_usd_ticks: 5000,
        total_cost_usd: 0.0000005
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({
        text: "",
        stopReason: "EndTurn",
        sessionId: sessionId,
        num_turns: 1,
        usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 }
      }) + "\\n");
    }
    process.exit(0);
  }

  // Kill-switch tests: disable the bridge while this run is in progress, as a user would.
  if (process.env.GROK_FAKE_DISABLE_DURING_RUN && process.env.GROK_CC_DISABLED_FLAG) {
    fs.mkdirSync(path.dirname(process.env.GROK_CC_DISABLED_FLAG), { recursive: true });
    fs.writeFileSync(
      process.env.GROK_CC_DISABLED_FLAG,
      JSON.stringify({ reason: "disabled mid-batch", disabledAt: new Date().toISOString() })
    );
  }

  // Connector-mode tests: write a prepared chat_history.jsonl where the real CLI keeps it,
  // <GROK_HOME>/sessions/<url-encoded cwd>/<session id>/, so the bridge's history check reads it.
  if (process.env.GROK_FAKE_HISTORY_FILE && process.env.GROK_HOME) {
    const sessionDir = path.join(
      process.env.GROK_HOME,
      "sessions",
      encodeURIComponent(flagValue("--cwd") || process.cwd()),
      sessionId
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    // The CLI persists the prompt verbatim as a user item, then on a resumed thread either
    // appends or — once pruning fires — rewrites the whole prior file with aged tool results
    // replaced and then appends this run (cli-1.0.45 mutations.rs:330-332 and :338-389).
    // GROK_FAKE_HISTORY_REWRITE is that rewrite. GROK_FAKE_HISTORY_OMIT_PROMPT leaves the user
    // item out, so a test can show a history that does not contain this run's marker.
    const historyFile = path.join(sessionDir, "chat_history.jsonl");
    const prepared = fs.readFileSync(process.env.GROK_FAKE_HISTORY_FILE);
    const promptLine = process.env.GROK_FAKE_HISTORY_OMIT_PROMPT
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify({ type: "user", content: [{ type: "text", text: prompt }] }) + "\\n");
    const thisRun = Buffer.concat([promptLine, prepared]);
    if (flagValue("-r") && process.env.GROK_FAKE_HISTORY_REWRITE && fs.existsSync(historyFile)) {
      const prior = rewritePrunedHistory(fs.readFileSync(historyFile, "utf8"));
      fs.writeFileSync(historyFile, Buffer.concat([Buffer.from(prior), thisRun]));
    } else if (flagValue("-r") && fs.existsSync(historyFile)) {
      fs.appendFileSync(historyFile, thisRun);
    } else {
      fs.writeFileSync(historyFile, thisRun);
    }
    if (process.env.GROK_FAKE_SPAWN_SUBAGENT) {
      const childDir = path.join(sessionDir, "subagents", "child-0001");
      fs.mkdirSync(childDir, { recursive: true });
      fs.writeFileSync(path.join(childDir, "meta.json"), JSON.stringify({
        subagent_id: "child-0001",
        status: "running",
        started_at: process.env.GROK_FAKE_SUBAGENT_STARTED_AT || new Date().toISOString()
      }));
    }
  }

  // Multi-object CLI streams exercise parseCliEnvelope order (envelope vs schema tail).
  if (scenario === "multi-object-stream") {
    const envelope = {
      text: "real answer from envelope",
      stopReason: "EndTurn",
      sessionId,
      num_turns: 2,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      structuredOutput: { verdict: "approve", findings: [] }
    };
    const schemaLike = { text: "model wrote this key itself", findings: [{ id: 1 }] };
    process.stdout.write(JSON.stringify(envelope) + JSON.stringify(schemaLike) + "\\n");
    process.exit(0);
  }

  // Bare {text} is model-shaped, not a CLI envelope (no stopReason/sessionId/usage).
  if (scenario === "bare-text-object") {
    process.stdout.write(JSON.stringify({ text: "bare text object not envelope" }) + "\\n");
    process.exit(0);
  }

  // Model JSON that carries text + usage-like meta must NOT look like a CLI envelope.
  if (scenario === "text-plus-usage-object") {
    process.stdout.write(
      JSON.stringify({
        text: "model text with usage field",
        usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
        sessionId: "model-invented-session"
      }) + "\\n"
    );
    process.exit(0);
  }

  // Oversized capture: bridge must set stdoutTruncated and fail the run.
  if (scenario === "huge-output") {
    const size = Number.parseInt(process.env.GROK_FAKE_HUGE_BYTES ?? "4096", 10);
    const chunk = "x".repeat(Math.max(1, size));
    process.stdout.write(chunk);
    process.exit(0);
  }

  let body;
  let structuredOnly = null;
  if (scenario === "echo-cwd") {
    // Reports the directory the agent was actually launched in, so a test can tell
    // where a run executed instead of only where its record claimed it would.
    body = "CWD:" + process.cwd();
  } else if (scenario === "empty-text") {
    body = "";
  } else if (scenario === "empty-then-ok") {
    // First headless turn is empty; a resume (nudge) returns content.
    body = isResume ? "Recovered after empty first turn." : "";
  } else if (scenario === "non-json") {
    // Schema-constrained runs must fail when the model returns prose only.
    body = "Definitely not a JSON object.";
  } else if (scenario === "structured-output-only") {
    // Empty text; deliverable lives only in structuredOutput (real CLI can do this).
    body = "";
    structuredOnly = {
      verdict: "approve",
      summary: "Structured-only deliverable.",
      findings: [],
      next_steps: ["Ship it."]
    };
  } else if (scenario === "structured-then-empty-nudge") {
    // First turn: SO only. Nudge/resume: empty with no SO — must keep first SO.
    if (isResume) {
      body = "";
      structuredOnly = null;
    } else {
      body = "";
      structuredOnly = {
        verdict: "approve",
        summary: "First structuredOutput must survive empty nudge.",
        findings: [],
        next_steps: ["Keep first SO."]
      };
    }
  } else if (scenario === "invalid-review-shape") {
    // Parses as JSON but missing fields the review renderer requires.
    body = JSON.stringify({
      verdict: "approve",
      summary: "Looks fine but incomplete."
    });
  } else if (hasFlag("--json-schema") || /critique|adversarial|structured|Return only valid JSON/i.test(prompt)) {
    body = JSON.stringify({
      verdict: "approve",
      summary: "No material issues found in the reviewed changes.",
      findings: [],
      next_steps: ["Ship it."]
    });
  } else if (/stop-gate review|ALLOW:|BLOCK:/i.test(prompt)) {
    body = "ALLOW: previous turn did not make code changes";
  } else if (/code review|Review the provided repository|Reviewing/i.test(prompt) || hasFlag("--agent")) {
    body = "Reviewed uncommitted changes.\\nNo material issues found.";
  } else {
    body = "Handled the requested task.";
  }

  // With --output-format json the real CLI wraps the answer in an envelope; emitting
  // the bare payload here would let the bridge's envelope handling go untested.
  if (flagValue("--output-format") === "json") {
    const envelope = {
      text: body,
      // grok 1.0.41 reports "cancelled" when a refused permission request ended the run.
      stopReason: process.env.GROK_FAKE_STOP_REASON || "EndTurn",
      sessionId,
      num_turns: 2,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    };
    // non-json: leave structuredOutput unset so schema-parse can fire at the bridge.
    if (structuredOnly != null) {
      envelope.structuredOutput = structuredOnly;
    } else if (hasFlag("--json-schema") && scenario !== "non-json" && body) {
      try {
        envelope.structuredOutput = JSON.parse(body);
      } catch {}
    }
    process.stdout.write(JSON.stringify(envelope) + "\\n");
  } else {
    process.stdout.write(body + "\\n");
  }
  // A max-turns exhaustion writes the envelope with stopReason cancelled and then exits
  // non-zero (cli-1.0.45 headless.rs:1403-1406, main.rs:2120-2128). Default stays 0.
  const fakeExit = Number.parseInt(process.env.GROK_FAKE_EXIT_STATUS ?? "0", 10);
  process.exit(Number.isInteger(fakeExit) ? fakeExit : 0);
} else {
  process.stderr.write("fake grok: unknown invocation: " + argv.join(" ") + "\\n");
  process.exit(1);
}
`;

  writeExecutable(scriptPath, source);

  // A bare `grok` on PATH is never executed on Windows (the loader searches PATHEXT and
  // finds the REAL grok.exe further along PATH), so tests silently ran against the live
  // CLI. Point GROK_BINARY at a .mjs entry point instead: the bridge runs script files
  // through the current Node executable, which is hermetic on every platform.
  const modulePath = path.join(binDir, "grok-fake.mjs");
  fs.writeFileSync(modulePath, source, "utf8");
  return scriptPath;
}

export function buildEnv(binDir, extra = {}) {
  return {
    ...process.env,
    GROK_BINARY: path.join(binDir, "grok-fake.mjs"),
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    // Each test's own kill-switch flag, never the real one under the user's home.
    GROK_CC_DISABLED_FLAG: path.join(binDir, "kill-switch", "disabled.json"),
    ...extra
  };
}
