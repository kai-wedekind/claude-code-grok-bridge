#!/usr/bin/env node
// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildReviewPrompt,
  DEFAULT_CONTINUE_PROMPT,
  NUDGE_PROMPT,
  extractLastJsonObject,
  getGrokAuthStatus,
  getGrokAvailability,
  isPlausibleSchemaObject,
  parseStructuredOutput,
  readOutputSchema,
  runHeadlessAgent,
  runImport,
  schemaInstructionsFromPath
} from "./lib/grok.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForSession,
  getSessionRuntimeStatus,
  readStoredJob,
  reclaimOrphanedJobs,
  resolveCancelableJob,
  resolveJobKindLabel,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { binaryAvailable, killTargetSettled, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  acquireGlobalSlot,
  acquireThreadLock,
  assertValidJobId,
  assertValidThreadName,
  claimJobTerminal,
  cleanTerminalJobs,
  deleteNamedThread,
  generateJobId,
  getNamedThread,
  listNamedThreads,
  setNamedThread,
  describeStateRootOrigin,
  listJobs,
  patchJobIfActive,
  resolveJobLogFile,
  resolveTrustedJobLogFile,
  resolveStateRoot,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  resolveJobKillTargets,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { collectUsage, renderUsage } from "./lib/usage-ledger.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  validateReviewResultShape
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
// Windows caps a command line near 32k and the schema travels on it, so anything past
// this fails inside spawn() with ENAMETOOLONG rather than anywhere a caller can read.
const MAX_JSON_SCHEMA_CHARS = 16000;
/**
 * Failures the bridge understood well enough to say that trying again cannot help.
 *
 * These get exit 2 — the documented contract for "there is no deliverable and here is
 * why" — even when the CLI itself happened to exit 1. An exhausted allowance stays
 * exhausted until it resets; an unauthenticated client stays unauthenticated until
 * somebody logs in. Everything else keeps the CLI's own status, because a caller may
 * legitimately retry it.
 */
const RETRY_CANNOT_HELP = new Set(["quota-exhausted", "not-authenticated"]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-bridge.mjs check [--json]",
      "  node scripts/grok-bridge.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <low|medium|high>] [--timeout-ms <ms>] [--max-turns <n>] [focus text]",
      "  node scripts/grok-bridge.mjs critique [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <low|medium|high>] [--timeout-ms <ms>] [--max-turns <n>] [focus text]",
      "  node scripts/grok-bridge.mjs usage [--days <n>] [--include-test-workspaces] [--json]",
      "  node scripts/grok-bridge.mjs run [--background] [--write] [--thread <name>] [--json-schema <json>] [--prompt-file <path>] [--prompts-file <path>] [--resume-last|--resume|--fresh (default)] [--model <model>] [--effort <low|medium|high>] [--timeout-ms <ms>] [--max-turns <n>] [prompt]",
      "  node scripts/grok-bridge.mjs import [--source <claude-jsonl>] [--thread <name>] [--json]",
      "  node scripts/grok-bridge.mjs runs [run-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--all-sessions] [--json]",
      "  node scripts/grok-bridge.mjs show [run-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
      "  node scripts/grok-bridge.mjs stop [run-id] [--json]",
      "  node scripts/grok-bridge.mjs threads [--forget <name>] [--json]",
      "  node scripts/grok-bridge.mjs clean [--keep <n>] [--older-than-ms <ms>] [--json]",
      "",
      // --cwd and --json are accepted almost everywhere and were previously discoverable
      // only from an error message or the README; repeating them on every line above
      // would have buried the flags that differ between commands.
      "Every command takes --json for machine-readable output. Every command except usage",
      "takes --cwd <dir> to say which workspace to act on; usage spans all of them.",
      "",
      "Env (bridge):",
      "  GROK_BINARY, GROK_CC_MAX_CONCURRENCY (0=unbounded), GROK_CC_SLOT_WAIT_MS,",
      "  GROK_CC_SESSION_ID, GROK_CC_TRANSCRIPT_PATH, CLAUDE_PLUGIN_DATA,",
      "  GROK_CC_STDOUT_CAP_BYTES (test knob; production default 32 MiB)"
    ].join("\n")
  );
}

function parsePositiveInt(value, flagName) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function resolveStoredJobExitStatus(job, storedJob = null) {
  const status = storedJob?.status ?? job?.status;
  if (status === "completed") {
    const payloadStatus = storedJob?.result?.status;
    if (Number.isFinite(Number(payloadStatus))) {
      return Number(payloadStatus);
    }
    return 0;
  }
  if (status === "failed") {
    const payloadStatus = storedJob?.result?.status;
    if (Number.isFinite(Number(payloadStatus)) && Number(payloadStatus) !== 0) {
      return Number(payloadStatus);
    }
    return 1;
  }
  if (status === "cancelled") {
    return 1;
  }
  return 1;
}

function resolveEffectiveConcurrency() {
  const envMax = Number.parseInt(process.env.GROK_CC_MAX_CONCURRENCY ?? "", 10);
  if (Number.isFinite(envMax)) {
    return envMax <= 0 ? "unbounded" : envMax;
  }
  let cpuCount = 8;
  try {
    cpuCount = os.cpus()?.length || 8;
  } catch {
  }
  return Math.max(8, cpuCount * 2);
}

function resolveEffectiveSlotWaitMs() {
  const envWait = Number.parseInt(process.env.GROK_CC_SLOT_WAIT_MS ?? "", 10);
  if (Number.isFinite(envWait) && envWait > 0) {
    return envWait;
  }
  return 90000;
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    // A single argument reaches here because a slash command handed the whole tail over as
    // one string. Only a LEADING flag makes that a packed argument list — the documented
    // contract everywhere else is flags first, then prompt, which is also what
    // `stopAtFirstPositional` enforces once parsing starts.
    //
    // So an argument that does not begin with `-` is a prompt, entire, and re-splitting it
    // is pure damage: quotation marks disappear, runs of whitespace collapse to one, and
    // nothing anywhere reports that the text was altered before it was sent.
    if (!raw.trim().startsWith("-")) {
      return [raw.trim()];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    unknownMode: config.unknownMode ?? "warn",
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
  if (parsed.unknown?.length) {
    for (const token of parsed.unknown) {
      process.stderr.write(`Warning: ignoring unknown option ${token}\n`);
    }
  }
  return parsed;
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

/** Parse a --json-schema value (string or object) for local validation only. */
function parseJsonSchemaObject(jsonSchema) {
  if (!jsonSchema) {
    return null;
  }
  if (typeof jsonSchema === "object" && !Array.isArray(jsonSchema)) {
    return jsonSchema;
  }
  if (typeof jsonSchema === "string") {
    try {
      const parsed = JSON.parse(jsonSchema);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }
  }
  return null;
}

/** Process exit code for a tracked execution (cancel never reports success). */
function resolveExecutionExitStatus(execution) {
  if (!execution) {
    return 1;
  }
  if (execution.cancelled && (execution.exitStatus === 0 || execution.exitStatus == null)) {
    return 1;
  }
  return execution.exitStatus ?? 0;
}

async function buildCheckReport(cwd, actionsTaken = []) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const grokStatus = getGrokAvailability(cwd);
  const authStatus = getGrokAuthStatus(cwd);
  const maxConcurrency = resolveEffectiveConcurrency();
  const slotWaitMs = resolveEffectiveSlotWaitMs();
  const stateRoot = resolveStateRoot();

  const nextSteps = [];
  if (!grokStatus.available) {
    nextSteps.push("Install the Grok Build CLI and ensure `grok` is on PATH (or set GROK_BINARY).");
  }
  if (grokStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Authenticate the Grok CLI (for example by running `grok` interactively and completing login).");
    nextSteps.push("Verify with `grok models` — a successful run means you are logged in.");
  }

  return {
    ready: nodeStatus.available && grokStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    grok: grokStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    bridge: {
      stateRoot,
      maxConcurrency,
      slotWaitMs
    },
    envHints: [
      `GROK_BINARY=${process.env.GROK_BINARY || "(default: grok on PATH)"}`,
      `GROK_CC_MAX_CONCURRENCY=${process.env.GROK_CC_MAX_CONCURRENCY ?? `(default → ${maxConcurrency})`}`,
      `GROK_CC_SLOT_WAIT_MS=${process.env.GROK_CC_SLOT_WAIT_MS ?? `(default → ${slotWaitMs})`}`,
      `CLAUDE_PLUGIN_DATA=${process.env.CLAUDE_PLUGIN_DATA || "(unset → temp state root)"}`,
      `state root=${stateRoot}`
    ],
    actionsTaken,
    nextSteps
  };
}

async function handleCheck(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  // Opportunistic orphan reaping so check also clears dead bridges from the run list.
  try {
    reclaimOrphanedJobs(resolveCommandWorkspace(options));
  } catch {
  }
  const finalReport = await buildCheckReport(cwd, []);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildCritiquePrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "critique");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Critique",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureGrokAvailable(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Grok CLI is not installed or not on PATH. Install it, set GROK_BINARY if needed, then rerun `/grok-build:check`."
    );
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

/**
 * True when this run's spend was never accounted for.
 *
 * `usage_is_incomplete` only ever arrives inside the CLI's final envelope, and a process
 * killed by the wall-clock timeout never gets to send one. The record then claimed full
 * accounting for a run that produced no accounting at all, and the ledger — which skips
 * jobs with no usage, no cost and no incomplete flag — dropped it without a word. Tokens
 * that were really spent simply vanished from the week's total instead of showing up as
 * unknown. Measured 2026-07-28: a run killed by a 20s timeout moved the ledger by nothing
 * at all.
 *
 * No estimate is attempted. Grok's session files keep a running token counter but not the
 * input/cache-read/output split, and those differ twentyfold in price — a number invented
 * from them would be worse than an honest gap.
 */
function usageUnaccounted(result, failureCode) {
  if (result.usageIncomplete === true) {
    return true;
  }
  return (
    failureCode != null &&
    result.usage == null &&
    !Number.isInteger(result.costTicks) &&
    typeof result.costUsd !== "number"
  );
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  return filterJobsForSession(jobs, { sessionId: getCurrentClaudeSessionId() });
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Reap orphaned actives first so a dead bridge cannot block --resume-last forever.
  const jobs = sortJobsNewestFirst(reclaimOrphanedJobs(workspaceRoot)).filter(
    (job) => job.id !== options.excludeJobId
  );
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Delegate run ${activeTask.id} is still running. Use /grok-build:runs before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  return null;
}

async function executeReviewRun(request) {
  ensureGrokAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);

  let prompt;
  let structured = false;
  if (reviewName === "Critique") {
    prompt = buildCritiquePrompt(context, focusText);
    const schemaHint = schemaInstructionsFromPath(REVIEW_SCHEMA);
    if (schemaHint) {
      prompt = `${prompt}\n\n${schemaHint}`;
    }
    structured = true;
  } else {
    prompt = buildReviewPrompt({
      targetLabel: context.target.label,
      focusText,
      collectionGuidance: context.collectionGuidance,
      reviewInput: context.content
    });
  }

  const result = await runHeadlessAgent(context.repoRoot, {
    prompt,
    agent: "explore",
    // Same read-only regime as the task path: real tool removal + deny rules instead
    // of interactive plan mode, which dead-ends headless.
    noPlan: true,
    sandbox: "read-only",
    disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
    denyRules: READ_ONLY_DENY_RULES,
    model: request.model,
    effort: request.effort,
    maxTurns: request.maxTurns ?? undefined,
    timeoutMs: request.timeoutMs ?? undefined,
    // JSON on both branches, and the plain one is the point. `plain` produced no CLI
    // envelope, so `result.usage` was always null, so the ledger's "skip records with no
    // usage, no cost and no ticks" rule dropped every successful review — silently, and
    // without the incomplete marker that exists precisely to make an unmeasured run
    // visible. Every review anyone has ever run is missing from the spend history, and a
    // week's calibration was built on the remainder.
    //
    // What carries the fix is the envelope branch: a real CLI envelope yields
    // `envelope.text` as the review and `envelope.usage` as the spend, which is everything
    // the ledger needs.
    //
    // The non-envelope fallback is close to the old behaviour but NOT identical, and the
    // first version of this comment claimed it was — an independent verification caught
    // the overstatement. Precisely: output that is not an envelope but whose last JSON
    // object carries a string `text` field yields that field rather than raw stdout,
    // because `envelopeHasText` is tested before `isEnvelope`. That is deliberate and
    // predates this change (see the `bare-text-object` and `text-plus-usage-object`
    // fixtures) — it simply is not "exactly what plain did". Two further differences: a
    // real envelope without text now counts as no deliverable rather than the raw JSON
    // becoming the review, which is what the task path has always done, and envelope text
    // is not trimEnd'ed the way raw stdout is.
    outputFormat: "json",
    jsonSchema: structured ? readOutputSchema(REVIEW_SCHEMA) : undefined,
    onProgress: request.onProgress
  });

  if (structured) {
    // Prefer the CLI's structuredOutput (same as the task path) so an envelope with
    // empty text but a valid SO is not false-failed as schema-parse / no-deliverable.
    const schemaObj = parseJsonSchemaObject(readOutputSchema(REVIEW_SCHEMA));
    let parsed;
    if (result.structuredOutput != null && typeof result.structuredOutput === "object") {
      const rawFromSo =
        String(result.finalMessage ?? "").trim() || JSON.stringify(result.structuredOutput);
      parsed = {
        status: result.status,
        failureMessage: result.stderr,
        parsed: result.structuredOutput,
        parseError: null,
        rawOutput: rawFromSo
      };
    } else {
      parsed = parseStructuredOutput(result.finalMessage, {
        status: result.status,
        failureMessage: result.stderr
      });
    }

    // Mirror the task deliverable gate: CLI exit 0 with empty output, unparseable
    // structured JSON, or a JSON object that does not match the review shape is a
    // bridge failure (exit 2), not a successful critique.
    // On any hard failure (timeout, cli-error, …), clear parsed.parsed so the
    // payload/renderer cannot present a full review as if the run succeeded —
    // same treatment as a shape failure. Partial text stays in rawOutput.
    let exitStatus = result.status;
    let failureCode = null;
    let failureMessage = "";
    if (result.timedOut) {
      failureCode = "timeout";
      failureMessage =
        `Grok run exceeded wall-clock timeout of ${result.timeoutMs ?? request.timeoutMs}ms.`;
      parsed = {
        ...parsed,
        parseError: failureMessage,
        parsed: null
      };
    } else if (result.status !== 0 || result.failureKind) {
      // The structured/critique sibling of the plain-review ladder below. Without
      // `|| result.failureKind` a fatal envelope on exit 0 fell through to the parse
      // check and was reported as `schema-parse` — sending the caller to fix a schema
      // over a lapsed session, which is the most expensive wrong answer available here.
      failureCode = result.failureKind ?? "cli-error";
      failureMessage =
        result.stderr || result.failureDetail || `Grok exited with status ${result.status}.`;
      if (RETRY_CANNOT_HELP.has(failureCode) || result.status === 0) {
        exitStatus = 2;
      }
      parsed = {
        ...parsed,
        parseError: failureMessage,
        parsed: null
      };
    } else if (result.stdoutTruncated) {
      // Checked before the parse result: truncated JSON usually fails to parse, and
      // reporting that as schema-parse would blame the model for output we cut off.
      exitStatus = 2;
      failureCode = "output-truncated";
      failureMessage = "Grok output exceeded the capture limit and was truncated.";
      parsed = {
        ...parsed,
        parseError: failureMessage,
        parsed: null
      };
    } else if (parsed.parseError || parsed.parsed == null) {
      const emptyText = !String(result.finalMessage ?? "").trim();
      const emptySo = result.structuredOutput == null;
      if (emptyText && emptySo) {
        exitStatus = 2;
        failureCode = "no-deliverable";
        failureMessage = "Grok returned no output.";
        parsed = {
          ...parsed,
          parseError: failureMessage,
          parsed: null
        };
      } else {
        exitStatus = 2;
        failureCode = "schema-parse";
        failureMessage = parsed.parseError || "Grok did not return valid structured JSON.";
      }
    } else {
      const shapeError =
        validateReviewResultShape(parsed.parsed) ||
        (!isPlausibleSchemaObject(parsed.parsed, schemaObj)
          ? "Grok returned JSON that does not match the review schema."
          : null);
      if (shapeError) {
        exitStatus = 2;
        failureCode = "schema-parse";
        failureMessage = shapeError;
        parsed = {
          ...parsed,
          parseError: shapeError,
          parsed: null
        };
      }
    }
    const payload = {
      review: reviewName,
      // The bridge's own exit class, like the task payload carries. `show` reads this
      // to reproduce the exit code of a stored run; without it a review that failed
      // with 2 replays as a generic 1 and the failure class is lost.
      status: exitStatus,
      target,
      threadId: result.threadId,
      context: {
        repoRoot: context.repoRoot,
        branch: context.branch,
        summary: context.summary
      },
      grok: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.finalMessage
      },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError,
      failureCode,
      failureMessage,
      timedOut: Boolean(result.timedOut),
      usage: result.usage ?? null,
      costUsd: typeof result.costUsd === "number" ? result.costUsd : null,
      costTicks: Number.isInteger(result.costTicks) ? result.costTicks : null,
      usageIncomplete: usageUnaccounted(result, failureCode)
    };

    return {
      exitStatus,
      threadId: result.threadId,
      turnId: null,
      payload,
      rendered: renderReviewResult(parsed, {
        reviewLabel: reviewName,
        targetLabel: context.target.label,
        // A cleared result means "no usable critique". That is not the same as "the
        // model returned bad JSON" — a timeout or a truncated capture clears it too.
        failureCode,
        failureMessage
      }),
      summary:
        parsed.parsed?.summary ??
        (failureMessage ||
          parsed.parseError ||
          firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`)),
      jobTitle: `Grok Build ${reviewName}`,
      jobClass: "review",
      targetLabel: context.target.label
    };
  }

  const emptyOutput = !String(result.finalMessage ?? "").trim();
  let exitStatus = result.status;
  let failureCode = null;
  let failureMessage = "";
  if (result.timedOut) {
    failureCode = "timeout";
    failureMessage =
      `Grok run exceeded wall-clock timeout of ${result.timeoutMs ?? request.timeoutMs}ms.`;
  } else if (result.status !== 0 || result.failureKind) {
    // `|| result.failureKind` covers the exit-0 fatal envelope: without it the CLI's own
    // error text became the review body, printed under the review heading with exit 0.
    failureCode = result.failureKind ?? "cli-error";
    failureMessage =
      result.stderr || result.failureDetail || `Grok exited with status ${result.status}.`;
    if (RETRY_CANNOT_HELP.has(failureCode) || result.status === 0) {
      exitStatus = 2;
    }
  } else if (result.stdoutTruncated) {
    // A truncated plain review still has non-empty text, so without this it would be
    // reported as a complete review.
    exitStatus = 2;
    failureCode = "output-truncated";
    failureMessage = "Grok output exceeded the capture limit and was truncated.";
  } else if (emptyOutput) {
    exitStatus = 2;
    failureCode = "no-deliverable";
    failureMessage = "Grok returned no output.";
  }

  const payload = {
    review: reviewName,
    // Same reason as the structured branch: `show` replays the exit class from here.
    status: exitStatus,
    target,
    threadId: result.threadId,
    grok: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage
    },
    // The README documents `rawOutput` as where a failure's own text survives — it is where
    // the auth remedy ("grok login --device-code") is preserved. The structured branch has
    // always had it and this one did not, so a caller who read the contract and scripted
    // against it got `undefined` from exactly the failure the sentence is about. One field
    // name across all three payload kinds; `grok.stdout` stays as it was.
    rawOutput: typeof result.finalMessage === "string" ? result.finalMessage : null,
    failureCode,
    failureMessage,
    timedOut: Boolean(result.timedOut),
    usage: result.usage ?? null,
    costUsd: typeof result.costUsd === "number" ? result.costUsd : null,
    costTicks: Number.isInteger(result.costTicks) ? result.costTicks : null,
    usageIncomplete: usageUnaccounted(result, failureCode)
  };
  const rendered = renderNativeReviewResult(
    {
      status: result.status,
      exitStatus,
      stdout: result.finalMessage,
      stderr: result.stderr,
      failureMessage,
      failureCode
    },
    { reviewLabel: reviewName, targetLabel: target.label }
  );

  return {
    exitStatus,
    threadId: result.threadId,
    turnId: null,
    payload,
    rendered,
    summary: firstMeaningfulLine(
      result.finalMessage,
      failureMessage || `${reviewName} completed.`
    ),
    jobTitle: `Grok Build ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

// Tools removed outright from read-only runs (headless-only flag). `search_replace`
// is the file-editing tool, `run_terminal_cmd` the shell — the two write paths.
// `search_tool` and `use_tool` are the MCP meta-tools: they do not write anything
// themselves, they reach a server that might. The deny rule below already rejects the
// MCPTool class at call time (verified by injection, 2026-07-28), but removing the two
// entry points as well costs nothing and does not depend on one rule engine getting a
// pattern right. Taken from tylersue/claude-grok-delegation, which pairs a positive
// allowlist with `--deny 'MCPTool(*)'` for exactly this reason.
//
// Deliberately NOT disallowing `web_search`, which that project also blocks: its
// read-only mode exists for code review, ours also carries research offloads where
// looking things up is the task.
const READ_ONLY_DISALLOWED_TOOLS = ["run_terminal_cmd", "search_replace", "search_tool", "use_tool"];
// Second layer: deny rules reject these tool classes even if a tool is reintroduced
// (e.g. by a subagent or a future default-tool change).
const READ_ONLY_DENY_RULES = ["Bash", "Write", "Edit", "MCPTool"];

/**
 * What actually confined this run — and, more to the point, what only looked like it did.
 *
 * `--sandbox read-only` is passed on every read-only run and is enforced by the kernel on
 * Linux and macOS. On Windows it is accepted and does nothing. That was written down in
 * the comments and in the README and nowhere the caller of a single run could see it: the
 * flag appeared on the command line, the run succeeded, and the payload said nothing about
 * a layer that had silently not applied.
 *
 * A degraded barrier that reports itself is the one thing worth taking from
 * tylersue/claude-grok-delegation, which prints `Sandbox: UNAVAILABLE — reads unconfined`
 * rather than letting a fail-open pass unremarked. We do not copy their fail-open — our
 * remaining layers are the ones that hold on Windows anyway — but the disclosure is right:
 * a caller deciding what to hand a read-only run deserves to know which barriers are real
 * on the machine in front of them.
 *
 * Write mode gets the same treatment for the opposite reason: it has no barrier at all,
 * which is easy to forget precisely because the read-only path has three.
 */
function describeConfinement(write, platform = process.platform) {
  if (write) {
    return {
      mode: "write",
      layers: [],
      kernelSandbox: "not-requested",
      disclosure:
        "Write mode: no confinement is enforced by this bridge — every tool is available " +
        "and --always-approve is set. The throwaway --cwd and your review of the diff are " +
        "the containment."
    };
  }
  const kernelEnforced = platform !== "win32";
  return {
    mode: "read-only",
    layers: kernelEnforced
      ? ["disallowed-tools", "deny-rules", "sandbox"]
      : ["disallowed-tools", "deny-rules"],
    kernelSandbox: kernelEnforced ? "enforced" : "requested-not-enforced",
    disclosure: kernelEnforced
      ? null
      : "Sandbox not enforced on this platform (win32): --sandbox read-only is passed and " +
        "ignored. Tool removal and deny rules are the whole barrier here."
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast,
    thread: request.thread
  });

  // Global slot FIRST, then the per-thread lock: holding the thread lock across the
  // machine-wide queue made the thread look busy for up to ~90s while nothing was
  // actually using the Grok session.
  const slot = await acquireGlobalSlot({
    onWait: (maxSlots) =>
      request.onProgress?.({
        message: `Waiting for a free Grok slot (max ${maxSlots} machine-wide).`,
        phase: "queued"
      }),
    onOverflow: (maxSlots) =>
      request.onProgress?.({
        message: `Queue wait exhausted (max ${maxSlots} machine-wide); starting anyway rather than failing the run.`,
        phase: "starting"
      })
  });

  // Serialize runs that continue the SAME named conversation: interleaving turns in
  // one Grok session corrupts its history for both callers.
  let threadLock = null;
  if (request.thread) {
    threadLock = acquireThreadLock(workspaceRoot, request.thread);
    if (!threadLock) {
      try {
        slot.release();
      } catch {
      }
      throw new Error(
        `Grok thread "${request.thread}" is already in use by another run. Wait for it to finish, or use a different --thread name.`
      );
    }
  }

  try {
    let resumeSessionId = null;
    if (request.resumeLast) {
      const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
        excludeJobId: request.jobId
      });
      if (!latestThread) {
        throw new Error("No previous Grok Build delegate session was found for this repository.");
      }
      resumeSessionId = latestThread.id;
    } else if (request.thread && !request.fresh) {
      // Named thread: continue this name's stored Grok session if one exists;
      // otherwise a new session starts and is registered under the name below.
      const namedThread = getNamedThread(workspaceRoot, request.thread);
      if (namedThread) {
        resumeSessionId = namedThread.sessionId;
      }
    }

    if (!String(request.prompt ?? "").trim() && !resumeSessionId) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
    }

    const prompt = String(request.prompt ?? "").trim() || (resumeSessionId ? DEFAULT_CONTINUE_PROMPT : "");
    // Write mode is sealed by the launch path (CLI --write / worker --write), never
    // promoted from a tampered on-disk request alone.
    const write = Boolean(request.write);

    // Read-only enforcement, in this order of reliability:
    //  1. --disallowed-tools removes the writing/executing tools from the toolset
    //     (headless-only, and the only barrier that holds on Windows).
    //  2. --deny rules reject those tool classes even if a tool slips back in.
    //  3. --sandbox read-only adds real kernel enforcement on Linux/macOS.
    // Plan mode is NOT used as a barrier: its "present plan, await approval" fork
    // dead-ends in headless mode (the stub bug), hence --no-plan.
    // The agent's working directory is the directory the CALLER asked for, not the
    // workspace root derived from it.
    //
    // These are two different questions and they were being answered with one value. The
    // workspace root has to be the git top level so a `git init` mid-run cannot orphan the
    // job record — that is a real fix and it stays. But `runHeadlessAgent` defaults the
    // agent's `--cwd` to the same value, so `--cwd packages/auth` silently became `--cwd
    // <repo root>`: wider than requested, including under `--write`, where `--cwd` is the
    // only containment there is. It contradicted the README's own example, SECURITY.md's
    // "point --cwd at the repository under review and nothing wider", and this file's own
    // comment calling the throwaway --cwd the containment.
    const agentCwd = request.cwd ? path.resolve(request.cwd) : workspaceRoot;
    const headlessOptions = {
      cwd: agentCwd,
      model: request.model,
      effort: request.effort,
      maxTurns: request.maxTurns ?? undefined,
      timeoutMs: request.timeoutMs ?? undefined,
      alwaysApprove: write,
      permissionMode: undefined,
      noPlan: !write,
      sandbox: write ? undefined : "read-only",
      disallowedTools: write ? undefined : READ_ONLY_DISALLOWED_TOOLS,
      denyRules: write ? undefined : READ_ONLY_DENY_RULES,
      outputFormat: "json",
      jsonSchema: request.jsonSchema ?? undefined,
      onProgress: request.onProgress
    };

    // Hold ONE machine-wide slot across the run AND its nudge: re-acquiring between
    // the two could block or fail and destroy an otherwise complete result.
    let result;
    let delivered = false;
    let nudged = false;
    let nudgeError = "";
    try {
      result = await runHeadlessAgent(workspaceRoot, {
        prompt,
        resumeSessionId,
        slot,
        ...headlessOptions
      });

      // Non-empty model text is a deliverable. stopReason is reported but never used
      // to discard usable text. For --json-schema runs, non-null CLI structuredOutput
      // also counts so a structured-only envelope is not false-failed then nudged.
      const hasDeliverable = (r) => {
        if (r.status !== 0) {
          return false;
        }
        // A failure the CLI named about itself is not an answer, however much text it
        // carries. Before this, an error envelope emitted with exit 0 was non-empty and
        // therefore "delivered": the caller got the error message rendered as the result,
        // with failureCode null and process exit 0.
        if (r.failureKind) {
          return false;
        }
        if (typeof r.finalMessage === "string" && r.finalMessage.trim().length > 0) {
          return true;
        }
        if (
          request.jsonSchema &&
          r.structuredOutput != null &&
          typeof r.structuredOutput === "object"
        ) {
          return true;
        }
        return false;
      };

      // Backstop: exit 0 with no output → one automatic nudge into the same session.
      // Never for --write runs: re-running a mutating task unattended could repeat
      // side effects that already happened.
      // …and never when the bridge already knows the retry cannot help: nudging a CLI that
      // just said nobody is signed in, or that the allowance is gone, spends a second run
      // to be told the same thing.
      if (
        !write &&
        result.status === 0 &&
        !RETRY_CANNOT_HELP.has(result.failureKind) &&
        !hasDeliverable(result)
      ) {
        const firstResult = result;
        try {
          const retry = await runHeadlessAgent(workspaceRoot, {
            prompt: NUDGE_PROMPT,
            resumeSessionId: result.sessionId,
            slot,
            ...headlessOptions
          });
          nudged = true;
          // Prefer the retry, but never drop the first structuredOutput if the nudge
          // did not produce one (failed/empty retry must not erase the first SO).
          result = {
            ...retry,
            structuredOutput: retry.structuredOutput ?? firstResult.structuredOutput ?? null
          };
        } catch (error) {
          // A failed retry must not destroy the (empty but honest) first result.
          nudgeError = error?.message ?? String(error);
          result = firstResult;
        }
      }

      delivered = hasDeliverable(result);
    } finally {
      // Slot released in the outer finally with the thread lock.
    }

    let rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";

    // Schema-constrained runs must yield a JSON object. Prefer the CLI's own parsed
    // structuredOutput; otherwise take the LAST complete JSON object in the text,
    // because one schema-constrained object is emitted per assistant message.
    // Fallback objects are validated against the schema's required keys so incidental
    // example JSON in prose cannot pass as schema success.
    let structured = null;
    let schemaFailure = "";
    if (delivered && request.jsonSchema) {
      const schemaObj = parseJsonSchemaObject(request.jsonSchema);
      if (result.structuredOutput != null && typeof result.structuredOutput === "object") {
        structured = result.structuredOutput;
      } else {
        const fallback = extractLastJsonObject(rawOutput);
        if (isPlausibleSchemaObject(fallback, schemaObj)) {
          structured = fallback;
        } else {
          structured = null;
        }
      }
      if (structured === null || typeof structured !== "object" || Array.isArray(structured)) {
        delivered = false;
        schemaFailure = "Grok output did not contain a JSON object despite --json-schema.";
        structured = null;
      } else if (!rawOutput.trim()) {
        // structuredOutput-only envelope: surface the object as the text deliverable.
        rawOutput = JSON.stringify(structured);
      }
    }

    // Truncated capture is never a trustworthy success: force failure even if some
    // text arrived before the cap.
    if (result.stdoutTruncated) {
      delivered = false;
    }

    // Register the named thread only for runs that actually produced something:
    // pointing a name at a failed session would poison every continuation.
    let threadRegistered = false;
    let threadRegistrationError = "";
    if (request.thread && delivered && result.sessionId) {
      try {
        setNamedThread(workspaceRoot, request.thread, result.sessionId);
        threadRegistered = true;
      } catch (error) {
        threadRegistrationError = `Could not register thread "${request.thread}": ${error?.message ?? error}`;
      }
    }

    // `result.failureKind` is consulted on BOTH exit paths. It used to be reachable only
    // through `status !== 0`, so a CLI that named its own failure and then exited 0 had that
    // name discarded — the run was reported as a plain no-deliverable, or worse, as success.
    const failureCode =
      result.timedOut
        ? "timeout"
        : result.status !== 0
          ? (result.failureKind ?? "cli-error")
          : result.failureKind
            ? result.failureKind
            : result.stdoutTruncated
              ? "output-truncated"
              : delivered
                ? null
                : schemaFailure
                  ? "schema-parse"
                  : "no-deliverable";
    // Exit 2 is the contract for "the bridge knows why there is no deliverable", so a
    // failure the bridge classified itself belongs there — even though the CLI happened
    // to exit 1. Otherwise the documented exit code and the real one disagree.
    const exitStatus =
      RETRY_CANNOT_HELP.has(failureCode)
        ? 2
        : result.status !== 0
          ? result.status
          : delivered
            ? 0
            : 2;
    // Hard failures only — registration issues and similar soft problems go in warnings
    // so a successful deliverable is not rendered as "Run did not succeed".
    const failureParts = [];
    const warnings = [];
    const confinement = describeConfinement(write);
    if (confinement.disclosure) {
      warnings.push(confinement.disclosure);
    }
    // Same principle, one layer down: a run recorded outside the shared state root is
    // invisible to every other surface, including the SessionEnd cleanup. The fallback is
    // deliberate; being quiet about it was not.
    const stateRootOrigin = describeStateRootOrigin();
    if (stateRootOrigin.disclosure) {
      warnings.push(stateRootOrigin.disclosure);
    }
    if (result.timedOut) {
      failureParts.push(
        `Grok run exceeded wall-clock timeout of ${result.timeoutMs ?? request.timeoutMs}ms.`
      );
    } else if (result.status !== 0 || result.failureKind) {
      // failureDetail carries the CLI's own remedy ("run grok login --device-code"). On the
      // exit-0 envelope path stderr is empty, so without it the caller would be told only
      // "Grok returned no output" for a failure the bridge had already named.
      failureParts.push(
        result.stderr || result.failureDetail || `Grok exited with status ${result.status}.`
      );
    } else if (!delivered) {
      failureParts.push(
        schemaFailure ||
          (result.stdoutTruncated
            ? "Grok output exceeded the capture limit and was truncated."
            : nudged
              ? "Grok returned no output, even after an automatic retry."
              : "Grok returned no output.")
      );
    }
    if (nudgeError) {
      failureParts.push(`Automatic retry could not run: ${nudgeError}`);
    }
    if (threadRegistrationError) {
      warnings.push(threadRegistrationError);
    }
    const failureMessage = failureParts.join(" ");
    // Only surface failureMessage on render when the run actually failed.
    const renderFailureMessage = !delivered || result.status !== 0 ? failureMessage : "";
    const rendered = renderTaskResult(
      {
        rawOutput,
        failureMessage: renderFailureMessage,
        warnings,
        usage: result.usage ?? null,
      costUsd: typeof result.costUsd === "number" ? result.costUsd : null,
      costTicks: Number.isInteger(result.costTicks) ? result.costTicks : null,
      usageIncomplete: usageUnaccounted(result, failureCode)
      },
      {
        title: taskMetadata.title,
        jobId: request.jobId ?? null,
        write,
        usage: result.usage ?? null,
      costUsd: typeof result.costUsd === "number" ? result.costUsd : null,
      costTicks: Number.isInteger(result.costTicks) ? result.costTicks : null,
      usageIncomplete: usageUnaccounted(result, failureCode)
      }
    );
    const payload = {
      status: exitStatus,
      threadId: result.threadId,
      rawOutput,
      delivered,
      failureCode,
      failureMessage,
      warnings,
      confinement,
      stateRoot: stateRootOrigin,
      nudged,
      timedOut: Boolean(result.timedOut),
      thread: request.thread ?? null,
      threadRegistered,
      structured,
      numTurns: result.numTurns ?? null,
      stopReason: result.stopReason ?? null,
      usage: result.usage ?? null,
      costUsd: typeof result.costUsd === "number" ? result.costUsd : null,
      costTicks: Number.isInteger(result.costTicks) ? result.costTicks : null,
      usageIncomplete: usageUnaccounted(result, failureCode)
    };

    return {
      exitStatus,
      threadId: result.threadId,
      turnId: null,
      payload,
      rendered,
      summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
      jobTitle: taskMetadata.title,
      jobClass: "task",
      write
    };
  } finally {
    try {
      threadLock?.release();
    } catch {
    }
    try {
      slot.release();
    } catch {
    }
  }
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Critique" ? "critique" : "review",
    title: reviewName === "Review" ? "Grok Build Review" : `Grok Build ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false, thread = null }) {
  const continuing = resumeLast || Boolean(thread);
  const title = thread
    ? `Grok Build Thread (${thread})`
    : resumeLast
      ? "Grok Build Resume"
      : "Grok Build Delegate";
  const fallbackSummary = continuing ? DEFAULT_CONTINUE_PROMPT : "Delegate";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /grok-build:runs ${payload.jobId} for progress.\n`;
}

function createBridgeJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: resolveJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id, { logFile })
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createBridgeJob({
    prefix: "run",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({
  cwd,
  model,
  effort,
  prompt,
  write,
  resumeLast,
  jobId,
  thread,
  fresh,
  jsonSchema,
  timeoutMs = null,
  maxTurns = null
}) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    thread: thread ?? null,
    fresh: Boolean(fresh),
    jsonSchema: jsonSchema ?? null,
    timeoutMs: timeoutMs ?? null,
    maxTurns: maxTurns ?? null
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Imported the Claude session into a Grok session.",
    payload.threadId ? `Grok session ID: ${payload.threadId}` : "Grok session ID: (not detected in import output)",
    payload.resumeCommand ? `Resume in Grok: ${payload.resumeCommand}` : "Resume with: grok -r <session-id>"
  ];
  if (payload.thread) {
    lines.push(
      payload.threadRegistered
        ? `Named thread registered: ${payload.thread}`
        : `Named thread not registered (${payload.thread}): ${payload.threadRegistrationError || "import produced no session id"}`
    );
  }
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  ensureGrokAvailable(cwd);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = runImport(cwd, { sourcePath });
  let threadRegistered = false;
  let threadRegistrationError = "";
  if (options.thread && result.threadId) {
    try {
      setNamedThread(workspaceRoot, options.thread, result.threadId);
      threadRegistered = true;
    } catch (error) {
      threadRegistrationError = error?.message ?? String(error);
    }
  }
  const payload = {
    threadId: result.threadId,
    resumeCommand: result.resumeCommand ?? (result.threadId ? `grok -r ${result.threadId}` : null),
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl"),
    stdout: result.stdout,
    thread: options.thread ?? null,
    threadRegistered,
    threadRegistrationError: threadRegistrationError || null
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast, thread = null, workspaceRoot = null) {
  // Empty prompt is only valid when continuing an existing conversation:
  // --resume-last, or a named thread that already has a registered session.
  // A brand-new --thread with no prompt used to pass preflight and then fail
  // mid-run without registering anything useful.
  if (String(prompt ?? "").trim()) {
    return;
  }
  if (resumeLast) {
    return;
  }
  if (thread) {
    if (workspaceRoot) {
      const named = getNamedThread(workspaceRoot, thread);
      if (named?.sessionId) {
        return;
      }
    }
    throw new Error(
      `Named thread "${thread}" has no existing session. Provide a prompt to start it, or use --resume-last.`
    );
  }
  throw new Error(
    // Name the flags. The prose version ("a prompt file") sent a caller looking for the
    // option in the docs and finding only --prompts-file, the batch one, which refuses
    // to combine with --background — so a long prompt ended up inline on the command
    // line, which is the ENAMETOOLONG that --prompt-file exists to prevent.
    "Provide a prompt: as an argument, via --prompt-file <path> (a single prompt), " +
      "via --prompts-file <path> (an NDJSON batch, not combinable with --background), " +
      "on piped stdin, with --thread <name> for an existing session, or --resume-last."
  );
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  const exitStatus = resolveExecutionExitStatus(execution);
  if (exitStatus !== 0) {
    process.exitCode = exitStatus;
  }
  return execution;
}

function spawnDetachedRunWorker(cwd, jobId, options = {}) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "grok-bridge.mjs");
  // Seal write mode on the worker argv — the worker must not trust request.write on disk.
  const args = [scriptPath, "run-worker", "--cwd", cwd, "--job-id", jobId];
  // Seal the workspace too, and for the same reason: it must not be re-derived later.
  //
  // resolveWorkspaceRoot returns the git root, or the raw cwd when there is no repo. A
  // --write agent that runs `git init` at or above its cwd therefore CHANGES its own
  // run's identity mid-flight, and every later state write lands in a different
  // directory than the record. Observed 2026-07-28: three background runs finished
  // their work completely, but the agent created a repository 43 seconds in; the job
  // records stayed "running" for good, no reader could find them by id, and the results
  // sat unnoticed on disk for 25 minutes. Nothing malicious — just an agent asked to set
  // up a project.
  if (options.workspaceRoot) {
    args.push("--workspace-root", options.workspaceRoot);
  }
  if (options.write) {
    args.push("--write");
  }
  const child = spawn(process.execPath, args, {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  // A spawn failure is asynchronous. `child.pid` is set optimistically and the failure —
  // EAGAIN, EMFILE — arrives on a later tick as an 'error' event. With no listener that
  // event is an unhandled error, so the process dies AFTER it has told the caller the run
  // was queued, and the record sits on "queued" holding a pid that never ran anything.
  // Nothing recovers that except the stale-reclaim grace, minutes later.
  //
  // Best-effort by construction: this parent is short-lived and unrefs the child, so it may
  // exit before the event fires at all. When it does fire in time, the record says what
  // happened rather than nothing.
  child.on("error", (error) => {
    try {
      claimJobTerminal(options.workspaceRoot ?? cwd, jobId, "failed", {
        errorMessage: `Background worker could not be started: ${
          error instanceof Error ? error.message : String(error)
        }`,
        phase: "failed",
        pid: null,
        agentPid: null,
        bridgePid: null
      });
    } catch {
    }
  });
  child.unref();
  return child;
}

export function enqueueBackgroundJob(cwd, job, request, options = {}) {
  // Always derive log path from job id (never a caller-supplied absolute path).
  const logFile = resolveJobLogFile(job.workspaceRoot, job.id);
  createJobLogFile(job.workspaceRoot, job.id, job.title);
  appendLogLine(logFile, "Queued for background execution.");

  const sealedWrite = Boolean(request?.write);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    agentPid: null,
    bridgePid: null,
    logFile,
    request: {
      ...request,
      // Persist for diagnostics only; the worker seals write from argv.
      write: sealedWrite
    }
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const spawnWorker = options.spawnWorker ?? spawnDetachedRunWorker;
  // job.workspaceRoot is where the record was just written. Hand exactly that to the
  // worker: it is the only value that stays true for the life of the run.
  const child = spawnWorker(cwd, job.id, {
    write: sealedWrite,
    workspaceRoot: job.workspaceRoot
  });
  const workerPid = child?.pid ?? null;
  if (workerPid != null) {
    patchJobIfActive(job.workspaceRoot, job.id, {
      status: "queued",
      phase: "queued",
      pid: workerPid,
      bridgePid: workerPid,
      // The worker is spawned as process.execPath, so this is what it is. Recorded here
      // and not only in runTrackedJob because the window between spawning the worker and
      // the worker patching its own record is exactly when a user hits stop on a run they
      // just changed their mind about — and until now that was the one current-version
      // record carrying a pid with no image to check it against.
      bridgeImage: path.basename(process.execPath),
      agentPid: null,
      logFile
    });
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      bridgePid: workerPid,
      pid: workerPid
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd", "timeout-ms", "max-turns"],
    booleanOptions: ["json", "background", "wait"],
    // Same rule as `run`, and for the same reason: the trailing positionals are free text a
    // user wrote about their code, and a word in it that happens to start with `--` must not
    // steer the command. `run` got this when "--write" inside a task description was found to
    // grant write access; review has the same shape and was left behind.
    //
    // The consequences here are quieter but not smaller. "--json" flips the output format out
    // from under a caller parsing text; "--base foo" both swallows the next word and reviews
    // a different range; and "--cwd <path>" silently points the whole review at another
    // directory. Documented order is flags first, then focus — which is exactly what this
    // enforces.
    stopAtFirstPositional: true,
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ? String(options.model).trim() : null;
  const effort = normalizeReasoningEffort(options.effort);
  const timeoutMs = parsePositiveInt(options["timeout-ms"], "--timeout-ms");
  const maxTurns = parsePositiveInt(options["max-turns"], "--max-turns");
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createBridgeJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  const request = {
    kind: "review",
    cwd,
    base: options.base,
    scope: options.scope,
    model,
    effort,
    focusText,
    reviewName: config.reviewName,
    timeoutMs,
    maxTurns
  };

  if (options.background && !options.wait) {
    ensureGrokAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

/**
 * Validate a --json-schema value, once, for every path that can carry one.
 *
 * The size cap used to live only in the single-run path, while the batch path
 * (--prompts-file) parsed the schema and let any size through. Both end up spawning the
 * CLI with the schema on the command line, so both hit the same ~32k Windows limit —
 * the batch caller just hit it deep inside spawn() instead of getting this message, and
 * the README's flat "16000" was true of one path and not the other.
 */
function validateJsonSchemaOption(value) {
  const jsonSchema = String(value);
  // A value option that swallowed the next flag is a silent footgun: "--json-schema
  // --write" would otherwise ship "--write" to the CLI as a schema.
  if (jsonSchema.startsWith("--")) {
    throw new Error(`--json-schema expects a JSON value, got the flag "${jsonSchema}".`);
  }
  let parsedSchema;
  try {
    parsedSchema = JSON.parse(jsonSchema);
  } catch {
    throw new Error("--json-schema must be valid JSON.");
  }
  if (!parsedSchema || typeof parsedSchema !== "object" || Array.isArray(parsedSchema)) {
    throw new Error("--json-schema must be a JSON Schema object, e.g. '{\"type\":\"object\", ...}'.");
  }
  // Windows caps a command line at ~32k; a huge schema would fail deep in spawn().
  if (jsonSchema.length > MAX_JSON_SCHEMA_CHARS) {
    throw new Error(
      `--json-schema is too large (${jsonSchema.length} characters); keep it under ${MAX_JSON_SCHEMA_CHARS} to stay within command-line limits.`
    );
  }
  return jsonSchema;
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model",
      "effort",
      "cwd",
      "prompt-file",
      "prompts-file",
      "thread",
      "json-schema",
      "timeout-ms",
      "max-turns"
    ],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    // Everything from the first prompt word on is task text, never flags: an unquoted
    // "--write" inside a task description must not grant write access.
    stopAtFirstPositional: true,
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ? String(options.model).trim() : null;
  const effort = normalizeReasoningEffort(options.effort);
  const timeoutMs = parsePositiveInt(options["timeout-ms"], "--timeout-ms");
  const maxTurns = parsePositiveInt(options["max-turns"], "--max-turns");
  const promptsFile = options["prompts-file"]
    ? path.resolve(cwd, String(options["prompts-file"]))
    : null;

  // Sequential multi-prompt batch: one NDJSON line per prompt, one result line each.
  // Not compatible with --background / --prompt-file / positional prompt.
  if (promptsFile) {
    if (options.background) {
      throw new Error("--prompts-file cannot be combined with --background.");
    }
    if (options["prompt-file"] || positionals.length > 0) {
      throw new Error("--prompts-file cannot be combined with --prompt-file or a prompt argument.");
    }
    await handlePromptsFileBatch({
      cwd,
      workspaceRoot,
      promptsFile,
      model,
      effort,
      write: Boolean(options.write),
      thread: options.thread ? assertValidThreadName(options.thread) : null,
      fresh: Boolean(options.fresh),
      resumeLast: Boolean(options["resume-last"] || options.resume),
      jsonSchema: options["json-schema"] ? String(options["json-schema"]) : null,
      timeoutMs,
      maxTurns,
      json: options.json
    });
    return;
  }

  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  // --fresh IS the default behavior (every run starts a new session unless --resume-last
  // is given). The flag exists so callers can be explicit and so templated invocations
  // that accidentally combine both flags fail loudly instead of resuming silently.
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const thread = options.thread ? assertValidThreadName(options.thread) : null;
  if (thread && resumeLast) {
    throw new Error("Choose either --thread <name> or --resume-last, not both.");
  }
  let jsonSchema = null;
  if (options["json-schema"]) {
    jsonSchema = validateJsonSchemaOption(options["json-schema"]);
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast,
    thread
  });
  requireTaskRequest(prompt, resumeLast, thread, workspaceRoot);

  if (options.background) {
    ensureGrokAvailable(cwd);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = {
      kind: "task",
      ...buildTaskRequest({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        thread,
        fresh,
        jsonSchema,
        timeoutMs,
        maxTurns
      })
    };
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        thread,
        fresh,
        jsonSchema,
        timeoutMs,
        maxTurns,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

function readPromptsFileLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const prompts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "string") {
        prompts.push(parsed);
      } else if (parsed && typeof parsed === "object" && typeof parsed.prompt === "string") {
        prompts.push(parsed.prompt);
      } else {
        throw new Error("expected a JSON string or {\"prompt\":\"...\"} object");
      }
    } catch (error) {
      throw new Error(
        `Invalid NDJSON on line ${index + 1} of ${filePath}: ${error?.message ?? error}`
      );
    }
  }
  if (prompts.length === 0) {
    throw new Error(`No prompts found in ${filePath}.`);
  }
  return prompts;
}

async function handlePromptsFileBatch(options) {
  if (options.resumeLast && options.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  if (options.thread && options.resumeLast) {
    throw new Error("Choose either --thread <name> or --resume-last, not both.");
  }
  let jsonSchema = options.jsonSchema;
  if (jsonSchema) {
    jsonSchema = validateJsonSchemaOption(jsonSchema);
  }

  const prompts = readPromptsFileLines(options.promptsFile);
  let worstExit = 0;
  // After the first prompt, continue via --resume-last so sequential lines share a thread
  // when the caller did not pass --thread (named threads already continue by name).
  let chainResume = Boolean(options.resumeLast);

  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    const resumeLast = options.thread ? false : chainResume;
    const taskMetadata = buildTaskRunMetadata({
      prompt,
      resumeLast,
      thread: options.thread
    });
    const job = buildTaskJob(options.workspaceRoot, taskMetadata, options.write);
    const { logFile, progress } = createTrackedProgress(job, { stderr: !options.json });
    const execution = await runTrackedJob(
      job,
      () =>
        executeTaskRun({
          cwd: options.cwd,
          model: options.model,
          effort: options.effort,
          prompt,
          write: options.write,
          resumeLast,
          thread: options.thread,
          fresh: index === 0 ? Boolean(options.fresh) : false,
          jsonSchema,
          timeoutMs: options.timeoutMs,
          maxTurns: options.maxTurns,
          jobId: job.id,
          onProgress: progress
        }),
      { logFile }
    );
    const exitStatus = resolveExecutionExitStatus(execution);
    const record = {
      index,
      jobId: job.id,
      exitStatus,
      threadId: execution.threadId ?? null,
      delivered: execution.payload?.delivered ?? null,
      failureCode: execution.payload?.failureCode ?? null,
      rawOutput: execution.payload?.rawOutput ?? null,
      rendered: execution.rendered
    };
    // Contract: one NDJSON object per prompt (scripting glue).
    process.stdout.write(`${JSON.stringify(record)}\n`);
    if (exitStatus !== 0 && (worstExit === 0 || exitStatus > worstExit)) {
      worstExit = exitStatus;
    }
    if (!options.thread && execution.threadId) {
      chainResume = true;
    }
  }

  if (worstExit !== 0) {
    process.exitCode = worstExit;
  }
}

function handleUsage(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["days"],
    booleanOptions: ["json", "include-test-workspaces"]
  });
  const days = Number.parseFloat(options.days ?? "7");
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("--days expects a positive number of days.");
  }
  const report = collectUsage({
    days,
    includeTestWorkspaces: Boolean(options["include-test-workspaces"])
  });
  outputCommandResult(report, renderUsage(report), options.json);
}

async function handleTransfer(argv) {

  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source", "thread"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const thread = options.thread ? assertValidThreadName(options.thread) : null;
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source,
    thread
  });
  outputCommandResult(payload, rendered, options.json);
}

async function readStoredJobWithRetry(workspaceRoot, jobId, options = {}) {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 25;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = readStoredJob(workspaceRoot, jobId);
    if (last) {
      return last;
    }
    await sleep(delayMs);
  }
  return last;
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id", "workspace-root"],
    booleanOptions: ["write"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for run-worker.");
  }

  const cwd = resolveCommandCwd(options);
  // Prefer the workspace the parent sealed on the argv over re-deriving it from cwd.
  // Re-deriving is what broke: resolveWorkspaceRoot answers with the git root, so an
  // agent running `git init` moves the answer, and every later write — including the
  // terminal claim — lands beside the record instead of on it. The record then says
  // "running" forever and no reader can find it.
  const workspaceRoot = options["workspace-root"] || resolveCommandWorkspace(options);
  const storedJob = await readStoredJobWithRetry(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its run request payload.`);
  }

  // The job JSON is untrusted: a crash can truncate it and anything running as this
  // user can edit it. The parent passed the identity and the location on the command
  // line, so those win and the record only supplies the payload. Taking the id from
  // the record would let it redirect logs and terminal claims onto a different run;
  // taking cwd from it would move where a --write run executes.
  const jobId = assertValidJobId(options["job-id"]);
  if (storedJob.id !== jobId) {
    throw new Error(
      `Stored record for ${jobId} claims id "${storedJob.id}"; refusing to run a record that is not the one requested.`
    );
  }

  const sealedWrite = Boolean(options.write);
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  if (!fs.existsSync(logFile)) {
    createJobLogFile(workspaceRoot, jobId, storedJob.title);
  }
  const { progress } = createTrackedProgress(
    {
      ...storedJob,
      id: jobId,
      workspaceRoot
    },
    {
      logFile
    }
  );

  const safeRequest = {
    ...request,
    cwd,
    write: sealedWrite,
    onProgress: progress
  };

  const runner =
    request.kind === "review" || storedJob.jobClass === "review"
      ? () => executeReviewRun(safeRequest)
      : () => executeTaskRun(safeRequest);

  const execution = await runTrackedJob(
    {
      ...storedJob,
      id: jobId,
      workspaceRoot,
      logFile,
      write: sealedWrite
    },
    runner,
    { logFile }
  );
  // Detached workers must surface the same exit contract as foreground runs;
  // cancel never reports process success (exit 0).
  const exitStatus = resolveExecutionExitStatus(execution);
  if (exitStatus !== 0) {
    process.exitCode = exitStatus;
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "all-sessions", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    // Wait deadline exceeded while the job is still active: distinct exit for scripting.
    if (options.wait && snapshot.waitTimedOut) {
      process.exitCode = 3;
    }
    return;
  }

  if (options.wait) {
    throw new Error("`runs --wait` requires a run id.");
  }

  const report = buildStatusSnapshot(cwd, {
    all: options.all,
    allSessions: Boolean(options["all-sessions"])
  });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";

  if (options.wait) {
    if (!reference) {
      throw new Error("`show --wait` requires a run id.");
    }
    const snapshot = await waitForSingleJobSnapshot(cwd, reference, {
      timeoutMs: options["timeout-ms"],
      pollIntervalMs: options["poll-interval-ms"]
    });
    if (snapshot.waitTimedOut) {
      outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
      process.exitCode = 3;
      return;
    }
    const storedJob = readStoredJob(snapshot.workspaceRoot, snapshot.job.id);
    const payload = { job: snapshot.job, storedJob };
    outputCommandResult(payload, renderStoredJobResult(snapshot.job, storedJob), options.json);
    process.exitCode = resolveStoredJobExitStatus(snapshot.job, storedJob);
    return;
  }

  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
  // Surface stored status as process exit so scripts can await-result without parsing JSON.
  process.exitCode = resolveStoredJobExitStatus(job, storedJob);
}

function handleThreads(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "forget"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);

  if (options.forget) {
    const name = assertValidThreadName(options.forget);
    const deleted = deleteNamedThread(workspaceRoot, name);
    const payload = { forgotten: name, deleted };
    const rendered = deleted
      ? `Forgot named thread "${name}".\n`
      : `Named thread "${name}" was not registered.\n`;
    outputCommandResult(payload, rendered, options.json);
    if (!deleted) {
      process.exitCode = 1;
    }
    return;
  }

  const threads = listNamedThreads(workspaceRoot);
  const entries = Object.entries(threads)
    .map(([name, entry]) => ({
      name,
      sessionId: entry?.sessionId ?? null,
      updatedAt: entry?.updatedAt ?? null
    }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const payload = { workspaceRoot, threads: entries };
  if (options.json) {
    outputResult(payload, true);
    return;
  }
  if (entries.length === 0) {
    process.stdout.write("No named threads registered for this workspace.\n");
    return;
  }
  const lines = ["Named threads:", ""];
  for (const entry of entries) {
    lines.push(`- ${entry.name}: ${entry.sessionId ?? "(no session)"}${entry.updatedAt ? ` (updated ${entry.updatedAt})` : ""}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function handleClean(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "keep", "older-than-ms"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const keep =
    options.keep != null && options.keep !== ""
      ? parsePositiveInt(options.keep, "--keep")
      : null;
  const olderThanMs =
    options["older-than-ms"] != null && options["older-than-ms"] !== ""
      ? parsePositiveInt(options["older-than-ms"], "--older-than-ms")
      : null;

  if (keep == null && olderThanMs == null) {
    throw new Error("clean requires --keep <n> and/or --older-than-ms <ms> (refuses to wipe all history without a filter).");
  }

  const result = cleanTerminalJobs(workspaceRoot, {
    keep: keep ?? 0,
    olderThanMs: olderThanMs ?? 0
  });
  const payload = {
    workspaceRoot,
    removed: result.removed,
    removedCount: result.removed.length,
    kept: result.kept
  };
  const rendered = `Cleaned ${result.removed.length} terminal run(s); ${result.kept} remain.\n`;
  outputCommandResult(payload, rendered, options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable delegate run found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable delegate run found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function expectedImageForPid(job, pid) {
  if (job?.agentPid != null && Number(job.agentPid) === pid && job.agentImage) {
    return job.agentImage;
  }
  if (
    (job?.bridgePid != null && Number(job.bridgePid) === pid) ||
    (job?.companionPid != null && Number(job.companionPid) === pid) ||
    (job?.pid != null && Number(job.pid) === pid)
  ) {
    return job.bridgeImage ?? null;
  }
  // A pid that matches no field is not a pid we should be aiming at, but the callers only
  // ever pass targets taken from this record — so this is the "record is older than the
  // field layout" case. Fall back to whatever image it does carry, exactly as the identical
  // function in job-control.mjs has always done. The two had drifted apart, and this copy
  // was the weaker one: it returned null, which used to mean "kill without checking".
  return job?.agentImage ?? job?.bridgeImage ?? null;
}

/**
 * Restore the kill targets on an already-cancelled record. Used when the kill was
 * attempted but not delivered: the agent is still out there, and a record with no pids
 * gives nobody a way to aim at it again.
 */
function patchStoppedJobKillTargets(workspaceRoot, jobId, sourceRecord, killResult) {
  // Only the targets that are NOT accounted for come back. Restoring all of them was
  // harmless while a cancelled record was unstoppable anyway, but it stops being harmless
  // the moment `isStoppableJob` accepts cancelled: a corpse pid restored onto the record
  // keeps the job in the stoppable list for good, and a bare `stop` with no run id then
  // refuses to do anything at all with "Multiple Grok Build runs are active".
  const settled = new Set(
    (killResult?.results ?? [])
      .filter((entry) => killTargetSettled(entry))
      .map((entry) => Number(entry.pid))
  );
  const unsettledOnly = (value) => {
    const pid = Number(value);
    return Number.isFinite(pid) && pid > 0 && !settled.has(pid) ? pid : null;
  };
  try {
    const stored = readStoredJob(workspaceRoot, jobId);
    if (!stored) {
      return;
    }
    writeJobFile(workspaceRoot, jobId, {
      ...stored,
      pid: unsettledOnly(sourceRecord.pid),
      agentPid: unsettledOnly(sourceRecord.agentPid),
      bridgePid: unsettledOnly(sourceRecord.bridgePid ?? sourceRecord.companionPid),
      killDelivered: false,
      errorMessage: "Stopped by user, but the process could not be confirmed killed."
    });
  } catch (error) {
    // Failing to record this must not turn a stop into an error — but it must not be
    // silent either. This is the write that keeps a surviving agent reachable; when it
    // fails, the record points at nobody and the only trace anyone will look for later
    // is the job log.
    try {
      appendLogLine(
        resolveTrustedJobLogFile({ workspaceRoot, id: jobId }),
        `Stop could not restore the kill targets; a surviving agent may now be unreachable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } catch {
    }
  }
}

function terminateJobProcessTrees(job) {
  const targets = resolveJobKillTargets(job);
  const results = [];
  // Per-pid try/catch so a failure killing agentPid never skips bridgePid.
  for (const pid of targets) {
    try {
      const expectedImage = expectedImageForPid(job, pid);
      results.push({
        pid,
        ...terminateProcessTree(pid, expectedImage ? { expectedImage } : {})
      });
    } catch (error) {
      results.push({
        pid,
        attempted: true,
        delivered: false,
        method: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (results.length === 0) {
    return { attempted: false, delivered: false, method: null, results: [] };
  }
  return {
    attempted: results.some((entry) => entry.attempted),
    // EVERY target, not some. A run has two of them — the agent and the bridge — and
    // `some` meant that killing either one reported the whole job as delivered. The
    // usual shape of a failed kill is exactly that: the bridge is gone or killable, the
    // agent is the one that survives. `stop` then skipped the restore below, having just
    // erased the pids, and the survivor was unreachable for good. SessionEnd got this
    // right (allDelivered) and this path did not.
    //
    // "Settled" rather than "delivered" because a target that had already exited must
    // not hold the whole job open: see killTargetSettled.
    delivered: results.every((entry) => killTargetSettled(entry)),
    method: results.map((entry) => entry.method).filter(Boolean).join("+") || null,
    results
  };
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? job;
  const preClaimRecord = { ...job, ...existing };
  const killTargets = resolveJobKillTargets(preClaimRecord);
  // Derived, never read from the record: `existing` came off disk, and every use below is
  // a write. Stop is the one command that runs when something has already gone wrong, so
  // its diagnostics are the last place that should follow a path an attacker chose.
  const logFile = resolveTrustedJobLogFile({ workspaceRoot, id: job.id });

  // A stopped run never reports what it spent: the CLI's JSON envelope, which is the only
  // place `total_cost_usd` ever comes from, arrives at the end of a run that now has no
  // end. The ledger skips records with no usage, no cost and no flag — so a stop used to
  // book as an exact zero. Saying "unknown" instead is what timeout and orphan reclaim
  // already do; stop and SessionEnd were the two paths still missing it, and three
  // cancelled runs on the morning of 2026-07-30 duly vanished from the weekly total.
  //
  // Not for a run that never started. A queued job with no process behind it did cost
  // nothing, and flagging that would trade an exact zero for a needless unknown.
  const mayHaveSpent = preClaimRecord.status === "running" || killTargets.length > 0;
  const usagePatch = mayHaveSpent ? { usageIncomplete: true } : {};

  const claim = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: "Stopped by user.",
    phase: "cancelled",
    pid: null,
    agentPid: null,
    bridgePid: null,
    logFile,
    ...usagePatch
  });

  // Which pids may this stop signal?
  //
  // Claim WON: the snapshot taken before the claim. The run was live and we just took
  // ownership of it, so those are our processes.
  //
  // Claim LOST: the run reached a terminal state on its own first. The snapshot then
  // describes a run that is over, and the operating system reissues pids — signalling
  // them hits whatever holds those numbers now. The image fingerprint is a real guard but
  // not against this: on a machine where several Grok agents run at once, the recycled pid
  // is most likely another grok.exe, which is exactly what the fingerprint waves through.
  // Only the pids the STORED record still carries are legitimate, and a record keeps them
  // in exactly one situation — an earlier kill was tried and not confirmed. Reaching that
  // survivor is the entire point; a completed run carries none and nothing is signalled.
  //
  // This matters for `failed` as much as for `cancelled`: stale reclaim marks a job failed
  // and deliberately keeps its pids so a later stop can finish the job. Gating on the
  // status alone would have blocked that, which is why the gate asks about targets.
  // (xai-org/grok-build-plugin-cc issue #3, opened 2026-07-16, and PR #11, opened 2026-07-29;
  // both were open upstream when last checked 2026-08-01.
  // Reachable here only through a genuine race, because listJobs heals the index from the
  // job file — but the condition was wrong either way, and the payload's own
  // `claimOrder: "claim-before-kill"` label helped disguise it.)
  //
  // `cancelled-merge` counts as a won claim here, and that is the whole exception. The claim
  // above passes explicit nulls — claim-before-kill clearing the targets — and on a record
  // that was ALREADY cancelled it lands in the merge branch, writes those nulls, and hands
  // back the record it just emptied. Reading the kill source from that is reading back our
  // own erasure: a second stop on a record whose targets a FIRST stop deliberately restored
  // aims at nothing, kills nothing, and leaves the record with no pids at all — after which
  // isStoppableJob no longer offers it, so the survivor is not merely missed this time but
  // permanently out of reach. The reasoning above holds for every other lost claim and fails
  // for this one, because in this one nobody else made the record terminal. We did.
  const killSource =
    claim.claimed || claim.reason === "cancelled-merge" ? preClaimRecord : (claim.job ?? {});
  const survivorTargets = resolveJobKillTargets(killSource);

  if (!claim.claimed && claim.status && claim.status !== "cancelled" && survivorTargets.length === 0) {
    const payload = {
      jobId: job.id,
      status: claim.status,
      title: claim.job?.title ?? job.title,
      killAttempted: false,
      killDelivered: false,
      // Same key set as the other exit below, including the ones that do not apply here.
      // `stop --json` is a documented surface, and a caller cannot branch on a field that
      // is sometimes absent and sometimes false without first learning which path it took —
      // which is the one thing the payload exists to tell it.
      killMethod: null,
      alreadyTerminal: true,
      claimOrder: "claim-gates-kill",
      claimed: false,
      killTargets
    };
    outputCommandResult(
      payload,
      `Job ${job.id} is already ${claim.status}; not overwritten by stop, and no process was signalled.\n`,
      options.json
    );
    return;
  }

  const killResult = terminateJobProcessTrees(killSource);

  // Clearing the kill targets is right when the processes are gone. When they are not —
  // access denied, a tree that outlived taskkill, or a kill this bridge REFUSED to make —
  // the agent is still running and would now be unreachable: nothing on the record points
  // at it any more. Put the targets back and say why.
  //
  // `attempted` used to gate this and must not, which SessionEnd learned on 2026-07-28 and
  // this path did not: a refusal reports `attempted: false` with no kill performed at all,
  // so the one outcome where the process is most certainly still alive was the one that
  // skipped the restore. Latent while refusals only happened on a recorded image mismatch;
  // no longer, now that a record with no recorded image is checked against the images a run
  // can have started. Not-delivered is the whole question, and killTargetSettled already
  // answers it — a process that had exited on its own counts as settled and does not hold
  // the record open.
  if (!killResult.delivered && survivorTargets.length > 0) {
    patchStoppedJobKillTargets(workspaceRoot, job.id, killSource, killResult);
  }

  appendLogLine(
    logFile,
    killResult.delivered
      ? "Stopped by user (claim-before-kill)."
      : `Stop claimed; process tree kill delivered=${killResult.delivered} method=${killResult.method ?? "none"}.`
  );

  // No pid keys in this patch, deliberately: an omitted key preserves what is stored, so
  // the targets patchStoppedJobKillTargets just put back survive this second claim. That
  // only became true once the cancelled-merge branch stopped nulling them outright.
  const merged = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: killResult.delivered
      ? "Stopped by user."
      : "Stop claimed but process may still be running (kill not delivered).",
    cancelKill: killResult,
    logFile,
    ...usagePatch
  });

  const nextJob = merged.job ?? claim.job ?? {
    ...existing,
    status: "cancelled",
    phase: "cancelled",
    title: job.title
  };
  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    killAttempted: killResult.attempted,
    killDelivered: killResult.delivered,
    killMethod: killResult.method,
    killTargets,
    alreadyTerminal: false,
    claimOrder: "claim-before-kill",
    claimed: claim.claimed
  };

  outputCommandResult(payload, renderCancelReport({ ...nextJob, ...payload }), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "check":
      await handleCheck(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "critique":
      await handleReviewCommand(argv, {
        reviewName: "Critique"
      });
      break;
    case "run":
      await handleTask(argv);
      break;
    case "import":
      await handleTransfer(argv);
      break;
    case "run-worker":
      await handleTaskWorker(argv);
      break;
    case "runs":
      await handleStatus(argv);
      break;
    case "show":
      await handleResult(argv);
      break;
    case "run-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "stop":
      await handleCancel(argv);
      break;
    case "threads":
      handleThreads(argv);
      break;
    case "clean":
      handleClean(argv);
      break;
    case "usage":
      handleUsage(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export {
  main,
  readStoredJobWithRetry,
  isPlausibleSchemaObject,
  describeConfinement,
  MAX_JSON_SCHEMA_CHARS,
  READ_ONLY_DISALLOWED_TOOLS,
  READ_ONLY_DENY_RULES
};