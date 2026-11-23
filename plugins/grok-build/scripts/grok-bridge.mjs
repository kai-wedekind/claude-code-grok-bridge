#!/usr/bin/env node
// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
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
  runGrok,
  runHeadlessAgent,
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
  assertValidSessionId,
  clearDisabledFlag,
  deleteNamedThread,
  generateJobId,
  getNamedThread,
  listNamedThreads,
  setNamedThread,
  describeStateRootOrigin,
  listJobs,
  readDisabledFlag,
  patchJobIfActive,
  resolveJobLogFile,
  resolveTrustedJobLogFile,
  resolveStateRoot,
  upsertJob,
  writeDisabledFlag,
  writeFileAtomic,
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
  failureHeadline,
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
import { collectSubagentEvidence } from "./lib/subagents.mjs";
import { assessConnectorRun } from "./lib/connector-evidence.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
/**
 * The reasoning-effort levels the Grok CLI's `--effort` flag accepts.
 *
 * ⚠ THESE FOUR ARE MEASURED, NOT COPIED, and where they came from matters more than the list.
 * Read from the shipped binary you get `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
 * `max`, which looks exactly like the flag's set and is not it — those seven belong to
 * something else in that binary. `grok --help` documents no values for the flag whatsoever.
 * The only authoritative statement of the set is the CLI's own rejection, which you can
 * obtain solely by getting it wrong:
 *
 *     grok --effort __probe__ -p x
 *     Error: --effort/--reasoning-effort: unknown effort level '__probe__';
 *            use one of: xhigh, high, medium, low
 *
 * Measured that way on 2026-08-21 against grok 1.0.5 (Windows) and grok 1.0.0 (Raspberry Pi),
 * which answer identically. `max`, `minimal` and `none` are refused by both.
 *
 * ⚠ THE FAILURE MODE THIS LIST HAS ALREADY CAUSED ONCE. It sat at three while xAI shipped
 * `xhigh` with grok-4.6, so the CLI's highest reasoning level was unreachable through this
 * plugin for months — and it failed as a *validation error*, which reads like a typo rather
 * than a missing capability. Nothing here noticed, because nothing here was looking.
 *
 * It was briefly replaced by forwarding whatever the caller typed and letting the CLI judge.
 * That removed the staleness and bought a worse problem: a misspelt effort then failed at CLI
 * launch as `failureCode: "cli-error"`, the same code that means the CLI died mid-task, which
 * calls for the opposite response. Fast, local, unambiguous refusal is worth more than
 * automatic tracking of a set that has not moved between the two CLI versions testable here.
 *
 * ⚠ SO THE STALENESS IS REAL AND UNSOLVED, and the honest mitigation is the probe above: when
 * a level is missing, re-measure rather than reasoning about the binary. `check --verify-tools`
 * does the equivalent for the read-only tool ids; doing it for effort is on the 0.4.0 list.
 *
 * The membership check doubles as an argv guard, which is the one part that must not be lost
 * if this ever becomes permissive again: a value that could be read as a flag must never reach
 * argv, or `--effort --write` would smuggle a second option into the CLI call.
 */
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
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
const RETRY_CANNOT_HELP = new Set([
  "quota-exhausted",
  "not-authenticated",
  "connector-refused",
  // Same request, same --max-turns, same stop. The partial text is already kept.
  "max-turns"
]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-bridge.mjs check [--verify-tools] [--fetch-update] [--json]",
      "  node scripts/grok-bridge.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <low|medium|high|xhigh>] [--timeout-ms <ms>] [--max-turns <n>] [focus text]",
      "  node scripts/grok-bridge.mjs critique [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <low|medium|high|xhigh>] [--timeout-ms <ms>] [--max-turns <n>] [focus text]",
      "  node scripts/grok-bridge.mjs usage [--days <n>] [--include-test-workspaces] [--json]",
      "  node scripts/grok-bridge.mjs run [--background] [--write | --connector <name>[,<name>...]] [--thread <name>] [--json-schema <json>] [--prompt-file <path>] [--prompts-file <path>] [--resume-last|--resume|--fresh (default)] [--model <model>] [--effort <low|medium|high|xhigh>] [--timeout-ms <ms>] [--max-turns <n>] [prompt]",
      "  node scripts/grok-bridge.mjs runs [run-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--all-sessions] [--json]",
      "  node scripts/grok-bridge.mjs show [run-id] [--wait] [--strands] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
      "  node scripts/grok-bridge.mjs stop [run-id] [--json]",
      "  node scripts/grok-bridge.mjs threads [--forget <name>] [--json]",
      "  node scripts/grok-bridge.mjs clean [--keep <n>] [--older-than-ms <ms>] [--json]",
      '  node scripts/grok-bridge.mjs disable --reason "<why>" [--json]',
      "  node scripts/grok-bridge.mjs enable [--json]",
      "",
      // --cwd and --json are accepted almost everywhere and were previously discoverable
      // only from an error message or the README; repeating them on every line above
      // would have buried the flags that differ between commands.
      "Every command takes --json for machine-readable output. Every command except usage",
      "takes --cwd <dir> to say which workspace to act on; usage spans all of them.",
      "",
      "Env (bridge):",
      "  GROK_BINARY, GROK_CC_MAX_CONCURRENCY (0=unbounded), GROK_CC_SLOT_WAIT_MS,",
      "  GROK_CC_SESSION_ID, GROK_CC_UPDATE_CHECK (0/off/false/no disables it),",
      "  CLAUDE_PLUGIN_DATA,",
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
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high, xhigh.`
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

  // A01. Same dynamic import the version block below uses — `version-check.mjs` is loaded on
  // demand rather than at module scope, and `check` is the only command that needs it. A
  // failure here must not take the whole report down: this line describes the install, and a
  // report that refuses to print because it cannot name a version is worse than one that
  // omits the name.
  let install = null;
  try {
    const vc = await import("./lib/version-check.mjs");
    install = vc.describeInstallIdentity(import.meta.url);
  } catch {
    install = null;
  }

  const nextSteps = [];
  if (!grokStatus.available) {
    nextSteps.push("Install the Grok Build CLI and ensure `grok` is on PATH (or set GROK_BINARY).");
  }
  if (grokStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Authenticate the Grok CLI (for example by running `grok` interactively and completing login).");
    nextSteps.push("Verify with `grok models` — a successful run means you are logged in.");
  }

  return {
    // ⚠ `ready` stays node + grok + auth. Version state is reported separately and
    // deliberately does NOT fold in here: `--verify-tools` already overloads exit 1 and 2, and
    // being three releases behind is not the same kind of fact as "the CLI is missing", and
    // neither is the disable flag below — a disabled bridge can be perfectly ready to run the
    // moment it is re-enabled, which `ready` should still say plainly.
    ready: nodeStatus.available && grokStatus.available && authStatus.loggedIn,
    disabled: readDisabledFlag(),
    node: nodeStatus,
    grok: grokStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    bridge: {
      stateRoot,
      maxConcurrency,
      slotWaitMs,
      // A01. Which build is actually loaded, and whether the three places that name a
      // version agree. `import.meta.url` is the only one of them that cannot lie: it is
      // the path Node resolved to reach this file.
      install
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

/**
 * Read a probe's debug log and say which of our ids the CLI did not recognise.
 *
 * Split out from the spawn so the judgement is testable. The spawn is not: it needs the real
 * binary, real auth and real allowance. Everything that can be wrong without those — the log
 * wording moving, the parse breaking, a green being manufactured out of an empty file — is in
 * here, and is covered by the unit suite.
 */
function interpretToolIdProbe(log, total) {
  // The CLI names the offending id on the line, so read them off rather than guessing which
  // of ours failed to match.
  //
  // ⚠ EVERY `tool=` on the line, not the first. The original ran one `exec` per line, and with
  // a non-greedy `.*?` the FIRST id won — so a line naming the control alongside a real id
  // reported only the control, passed the gate below, and returned `checked: true` with the
  // real one silently dropped. Today's CLI writes one id per line, so this was a hole in the
  // contract rather than a live false clear. Closed anyway: "the format currently happens to
  // suit us" is not a property anybody is maintaining. (Found by an independent audit of the
  // commit that introduced it, 2026-08-08.)
  const unmatched = [];
  for (const line of String(log).split(/\r?\n/)) {
    if (!line.includes("disallowedTools entry matched nothing")) continue;
    for (const hit of line.matchAll(/tool=(\S+)/g)) {
      if (!unmatched.includes(hit[1])) unmatched.push(hit[1]);
    }
  }

  // THE CONTROL, and the reason this check is worth having. We pass one id that cannot exist,
  // so a working probe MUST report it. If it does not, the probe is blind — the log wording
  // moved, the flag was renamed, the parse broke — and the honest answer is "I do not know",
  // never "all clear". Without this, the check degrades into a permanent green the first time
  // xAI rewords one log line, which is exactly the silent-failure shape it exists to expose.
  if (!unmatched.includes(TOOL_ID_PROBE_CONTROL)) {
    return {
      checked: false,
      total,
      unmatched: [],
      error: "the probe's own control id was not reported — cannot read this CLI's log"
    };
  }
  return {
    checked: true,
    total,
    unmatched: unmatched.filter((id) => id !== TOOL_ID_PROBE_CONTROL)
  };
}

/**
 * Ask the installed CLI whether it still recognises every id in the read-only removal list.
 *
 * WHY THIS IS NEEDED AT ALL. An id the CLI does not know removes nothing. It sits in the list
 * reading as protection, and the barrier is one tool weaker than the code claims. The CLI does
 * notice — it emits `disallowedTools entry matched nothing` — but only into the `--debug-file`
 * log, which nothing reads unless someone goes looking.
 *
 * Measured 2026-08-08 against grok 1.0.0, passing a deliberately bogus id: **stderr was 0
 * bytes**, stdout was the model's answer and nothing else, and the sole trace was one line in
 * the debug file. So the failure is invisible on every surface a person actually sees.
 *
 * ⚠ The unit suite pins this list against a SNAPSHOT, which catches us changing it. It cannot
 * catch xAI renaming a tool underneath us: the snapshot still matches, the test still passes,
 * and the barrier quietly degrades. That is the gap this closes, and it is why the check has
 * to talk to the binary rather than to our own constant.
 *
 * 🚫 OPT-IN ON PURPOSE. The warning is emitted at session spawn, so there is no way to ask
 * without starting a real run and spending real allowance. A `check` that quietly billed the
 * user every invocation would be its own small dishonesty, in the command whose whole job is
 * telling you the truth about your setup.
 */
function verifyDisallowedToolIds(cwd) {
  const total = READ_ONLY_DISALLOWED_TOOLS.length;
  const unknown = (error) => ({
    checked: false,
    total,
    unmatched: [],
    error
  });
  const debugFile = path.join(os.tmpdir(), `grok-cc-toolcheck-${process.pid}-${Date.now()}.log`);
  try {
    // ⚠ The same flags a real read-only run uses, not a minimal subset. A probe that spawns a
    // DIFFERENT session from the one we ship can only answer for the session it spawned — and
    // the requirement graph, which is the thing that killed us, is a property of the whole flag
    // set. `--no-plan` is still passed and a headless run ignores it: the only consumer is
    // the TUI (event_loop.rs:1116); HeadlessOptions has no plan field (headless.rs:53-95).
    // Harmless TUI parity.
    const result = runGrok(
      [
        "-p",
        "Reply with the single word OK.",
        "--no-plan",
        "--sandbox",
        // The same profile every other read-only launch passes.
        // On a Linux kernel without Landlock, `read-only` is the profile current CLIs
        // refuse to start (config/mod.rs:1489-1495).
        readOnlySandboxProfile(),
        "--disallowed-tools",
        [...READ_ONLY_DISALLOWED_TOOLS, TOOL_ID_PROBE_CONTROL].join(","),
        ...READ_ONLY_DENY_RULES.flatMap((rule) => ["--deny", rule]),
        "--debug-file",
        debugFile
      ],
      // ⚠ BOUND IT. This spawns a real model run, and it had no timeout while every other
      // launch path in the bridge does — so a wedged CLI or a stalled network hangs `check`
      // indefinitely, with no output. That is the diagnostic command hanging on exactly the
      // broken environment it exists to diagnose, which is worse than it failing: a hang gives
      // the reader nothing at all to act on. Two minutes is far beyond a healthy probe (a real
      // one answers in seconds) and far short of "I'll come back later". Found by a code review
      // 2026-08-09.
      { cwd, timeoutMs: 120000 }
    );
    // runCommand RETURNS a failure, it does not throw one — so a run that died on auth or on
    // an exhausted allowance would otherwise sail past the catch and be read off a log that
    // never described this probe.
    if (result.error) return unknown(result.error.message);
    if (result.signal || result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
      // ⚠ A requirement-graph failure is NOT the same class as "not signed in". Both leave a
      // non-zero exit, and bucketing them together is what made this bug take an afternoon:
      // the report said "the probe did not run", so it read as an environment problem rather
      // than as a broken removal list. It is the one failure here that IS about our list, so
      // it gets named and gets its own finding.
      if (/requirements unsatisfied|session initialization failed/i.test(detail)) {
        const dependent = /tool:\s*\\?"([^\\"]+)/.exec(detail);
        return {
          checked: false,
          total,
          unmatched: [],
          // ⚠ The discriminator that reaches the EXIT CODE. `checked: false` is right — we
          // learned nothing about the individual ids — but this failure is nonetheless a
          // finding about OUR list, not about the environment, and the two want different
          // exit codes and different human responses. Without this flag it shared code 2
          // with "not signed in", so automation would retry forever against a dead barrier.
          listBroken: true,
          requiresAlso: dependent ? dependent[1] : null,
          error:
            `the removal list stops this CLI from starting a session at all` +
            (dependent ? ` — it also wants ${dependent[1]} removed` : "") +
            `. Every read-only run is dead until the list is fixed.`
        };
      }
      return unknown(detail);
    }
    if (!fs.existsSync(debugFile)) return unknown("the CLI wrote no debug log");
    return interpretToolIdProbe(fs.readFileSync(debugFile, "utf8"), total);
  } catch (error) {
    // A failed probe is not a clean bill of health, and must never read as one.
    return unknown(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      fs.rmSync(debugFile, { force: true });
    } catch {
    }
  }
}

async function handleCheck(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "verify-tools", "fetch-update"]
  });

  const cwd = resolveCommandCwd(options);
  // Opportunistic orphan reaping so check also clears dead bridges from the run list.
  try {
    reclaimOrphanedJobs(resolveCommandWorkspace(options));
  } catch {
  }
  const finalReport = await buildCheckReport(cwd, []);

  // Version state, always reported. Cache-only unless asked to fetch: `check` is a diagnostic
  // and should not make an outbound request every time somebody runs it, but it is also the
  // one command whose job is telling you the truth about your setup, so it must never omit
  // this line — an omitted line reads as "fine", which is the failure this release is about.
  try {
    const vc = await import("./lib/version-check.mjs");
    const running = vc.resolveRunningVersion(import.meta.url);
    // ⚠ An EXPLICIT --fetch-update overrides the ambient opt-out, and says so when it cannot.
    // Gating the explicit request on `GROK_CC_UPDATE_CHECK=0` meant the flag silently did
    // nothing, and the report then typically ended "Run `check --fetch-update` to ask now" —
    // recommending the exact command that had just been suppressed, with nothing saying why.
    // The opt-out exists to stop the plugin reaching the network ON ITS OWN; a person typing
    // the flag is not the plugin acting on its own. Found by a code review 2026-08-09.
    if (options["fetch-update"]) {
      const { cache } = await vc.readCacheBounded(2000);
      const result = await vc.fetchLatestVersion({ timeoutMs: vc.FETCH_TIMEOUT_MS, running });
      const next = vc.recordFetchResult(cache, result, Date.now());
      try {
        writeFileAtomic(vc.resolveUpdateCacheFile(), `${JSON.stringify(next, null, 2)}\n`);
      } catch {
      }
      finalReport.update = vc.evaluateUpdateState(next, running);
    } else {
      const { cache } = await vc.readCacheBounded(2000);
      finalReport.update = vc.evaluateUpdateState(cache, running);
    }
  } catch (error) {
    finalReport.update = {
      state: "unknown",
      running: null,
      latest: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  if (options["verify-tools"]) {
    // ⚠ Checked here rather than via assertBridgeEnabled(), and deliberately not thrown.
    // `--verify-tools` is an add-on to `check`, not a command of its own — throwing would
    // discard the node/grok/auth/version report along with it, the one thing `check` exists
    // to show while disabled. So this starts no process at all and reports the same
    // "could not check" shape verifyDisallowedToolIds itself uses on failure, which the
    // renderer already treats as exit 2 below — a real finding about the removal list and
    // "the bridge would not even ask" must not share an exit code with each other.
    const disabledFlag = readDisabledFlag();
    finalReport.toolIds = disabledFlag
      ? {
          checked: false,
          total: READ_ONLY_DISALLOWED_TOOLS.length,
          unmatched: [],
          error: `Grok Build is disabled: ${disabledFlag.reason} — verify-tools needs a real CLI session and none will run`
        }
      : verifyDisallowedToolIds(cwd);
    // ⚠ The verdict has to reach the EXIT CODE, not only the text. A check that prints
    // "3 of 14 MATCH NOTHING" and then exits 0 is read as success by everything that does not
    // have eyes — CI, a shell `&&`, a release script — which is the precise false-green shape
    // this command exists to remove. `1` for a real finding, `2` for "I could not tell",
    // because those want different responses: fix the list, versus fix the environment and
    // ask again. (Found by an independent audit, 2026-08-08: the flag reported honestly and
    // exited 0 regardless.)
    if (finalReport.toolIds.unmatched.length > 0 || finalReport.toolIds.listBroken) {
      // 1 = a real finding about the list. `listBroken` belongs here and not with the unknowns:
      // it means the removal list stops the CLI from starting a session at all, which is the
      // most severe thing this command can discover, and it was landing on 2 — the code that
      // tells automation to fix its environment and try again.
      process.exitCode = 1;
    } else if (!finalReport.toolIds.checked) {
      process.exitCode = 2;
    }
  }
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
 * `usage_is_incomplete` arrives on the CLI's final envelope and, on a fatal error, on the
 * spend projection attached at the top level of that error object (headless.rs:351-359).
 * A process killed by the wall-clock timeout never gets to send
 * either. The record then claimed full accounting for a run that produced no accounting
 * at all, and the ledger — which skips
 * jobs with no usage, no cost and no incomplete flag — dropped it without a word. Tokens
 * that were really spent simply vanished from the week's total instead of showing up as
 * unknown. Measured 2026-07-28: a run killed by a 20s timeout moved the ledger by nothing
 * at all.
 *
 * No estimate is attempted. Grok's session files keep a running token counter but not the
 * input/cache-read/output split, and those differ twentyfold in price — a number invented
 * from them would be worse than an honest gap.
 */
/**
 * Sum two launches' spend, keeping "we could not tell" distinguishable from "it was zero".
 * A missing side yields the side we have — the caller records `spendIncomplete` separately, so
 * the number is the best available and the record still says it is partial.
 */
function addUsage(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = {};
  for (const k of keys) {
    const left = typeof a[k] === "number" ? a[k] : 0;
    const right = typeof b[k] === "number" ? b[k] : 0;
    out[k] = left + right;
  }
  return out;
}

function addCostTicks(a, b) {
  if (!Number.isInteger(a)) return Number.isInteger(b) ? b : null;
  return Number.isInteger(b) ? a + b : a;
}

function addCostUsd(a, b) {
  if (typeof a !== "number") return typeof b === "number" ? b : null;
  return typeof b === "number" ? a + b : a;
}

function addTurns(a, b) {
  if (!Number.isInteger(a)) return Number.isInteger(b) ? b : null;
  return Number.isInteger(b) ? a + b : a;
}

function launchHasUsageWithoutCost(result) {
  return Boolean(result?.usage) && !Number.isInteger(result?.costTicks) && typeof result?.costUsd !== "number";
}

function launchReportedCost(result) {
  return Number.isInteger(result?.costTicks) || typeof result?.costUsd === "number";
}

function usageUnaccounted(result, failureCode) {
  if (result.usageIncomplete === true) {
    return true;
  }
  // A nudged run whose two launches could not both be measured is partial accounting, and must
  // say so even though it succeeded. Every other branch here keys off a FAILURE code, so a
  // successful-but-half-counted run had no way to be marked. That is precisely the run this
  // matters for: the nudge fires when a turn produced nothing, which is the expensive case.
  if (result.spendIncomplete === true) {
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

// Missing means the default. `0` is a real wait: check once, do not sit for four minutes.
// A negative or non-finite value is a usage error. `Number("0") || default` would turn both
// `0` and a typo into DEFAULT_STATUS_WAIT_TIMEOUT_MS (upstream #57).
// This is only the `runs`/`show --wait` clock. The run wall-clock flag stays on parsePositiveInt.
function parseDurationOption(name, raw, defaultMs) {
  if (raw === undefined || raw === null || raw === "") {
    return defaultMs;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `--${name} must be a non-negative number of milliseconds, got ${JSON.stringify(String(raw))}.`
    );
  }
  return Math.floor(parsed);
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = parseDurationOption("timeout-ms", options.timeoutMs, DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  // The 100ms floor stays. `0` and a non-numeric interval still mean the default poll;
  // only --timeout-ms treats 0 as check-once and rejects a bad value (upstream #57).
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
    // ⚠ VALIDATE IT HERE TOO. This id becomes a path segment inside the CLI and reaches argv as
    // `-r <value>` — which is precisely why `assertValidSessionId` exists, and why its own
    // comment says it refuses path-like values "so a tampered named-threads.json cannot
    // redirect resume into an attacker-chosen path". The named-thread route enforces it, and
    // `subagents.mjs` independently re-derives the same guard for the same value. This route,
    // reading straight off a job record on disk, was the one way around it. Two enforcing paths
    // and one open one is worse than none: the guard's existence is what stops anyone looking.
    // Found by an architectural review 2026-08-09.
    //
    // Honest scope: anyone who can edit the stored record already controls the prompt, so this
    // closes an inconsistency rather than an exposure. It goes in because the value is a PATH
    // fragment, which is the case the guard was written for.
    assertValidSessionId(trackedTask.threadId);
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
  // Read-only always, on both return paths below. Computed once here so neither can be added
  // later without it — the previous shape put this in the task run only, and `review` inherited
  // the barrier while inheriting none of the honesty about it.
  const reviewConfinement = describeConfinement(false);

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

  // Acquire the slot first, then re-check, and pass the slot down. A check made here before
  // runHeadlessAgent waited for its own slot would let a review or critique already queued when
  // `disable` landed still start a session, foreground and background alike. Collecting the
  // context can also take a while.
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
  try {
    assertBridgeEnabled();
  } catch (error) {
    try {
      slot.release();
    } catch {
    }
    throw error;
  }
  let result;
  try {
    result = await runHeadlessAgent(context.repoRoot, {
      prompt,
      agent: "explore",
      // Same read-only regime as the task path: tool removal and deny rules. `--no-plan`
      // is still passed and a headless run ignores it. Since 2026-08-09 the same disclosure,
      // computed here so both return paths carry it. `review` is never a write run.
      noPlan: true,
      sandbox: readOnlySandboxProfile(),
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
      // visible.
      //
      // What carries the fix is the envelope branch: a real CLI envelope yields
      // `envelope.text` as the review and `envelope.usage` as the spend, which is everything
      // the ledger needs.
      //
      // The non-envelope fallback is close to the old behaviour but NOT identical. Precisely:
      // output that is not an envelope but whose last JSON object carries a string `text` field
      // yields that field rather than raw stdout,
      // because `envelopeHasText` is tested before `isEnvelope`. That is deliberate and
      // predates this change (see the `bare-text-object` and `text-plus-usage-object`
      // fixtures) — it simply is not "exactly what plain did". Two further differences: a
      // real envelope without text now counts as no deliverable rather than the raw JSON
      // becoming the review, which is what the task path has always done, and envelope text
      // is not trimEnd'ed the way raw stdout is.
      outputFormat: "json",
      jsonSchema: structured ? readOutputSchema(REVIEW_SCHEMA) : undefined,
      // Caller-owned: runHeadlessAgent must not wait again or release this slot.
      slot,
      onProgress: request.onProgress
    });
  } finally {
    try {
      slot.release();
    } catch {
    }
  }

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
      // ⚠ SAY WHAT CONFINED THIS RUN, exactly as the task path does. `describeConfinement` had
      // a single call site, inside the task run — so `review` and `critique` launched under the
      // identical read-only regime and disclosed nothing about it: no "sandbox not enforced on
      // this platform" on Windows, no Landlock-absent line on a kernel without it. A user
      // reviewing an untrusted repository is the case that most needs to know which layers are
      // actually holding, and it was the one command that never said. Found by an architectural
      // review 2026-08-09. ⚠ The real fix is to make this a property of the LAUNCH rather than
      // of each command — otherwise a fifth command is born without it — and that refactor is
      // 0.4.0; this closes the hole in the meantime.
      confinement: reviewConfinement,
      warnings: reviewConfinement.disclosure ? [reviewConfinement.disclosure] : [],
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
      // A parsed critique summarises itself; a failed one gets the shared headline, like the
      // task and native-review paths. Without it an auth failure listed itself as "Grok
      // exited with status 1", because `failureDetail` is null there and `failureMessage`
      // falls through to the exit status.
      summary:
        parsed.parsed?.summary ??
        (failureCode ? failureHeadline(failureCode) : null) ??
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
    // Same descriptor as the structured branch, for the same reason. Two return paths out of
    // one function is exactly how a disclosure ends up on one of them: the failure-headline
    // fix earlier in this file's history had to be applied to each branch separately, each
    // time with a comment explaining what the missing copy had done wrong.
    confinement: reviewConfinement,
    warnings: reviewConfinement.disclosure ? [reviewConfinement.disclosure] : [],
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
    // Same rule as the task path: on a failure `finalMessage` is the CLI's error envelope,
    // so summarising a native review with its first line printed `{"type":"error"...` into
    // the runs list. A classified failure names itself; everything else is unchanged.
    summary:
      (failureCode ? failureHeadline(failureCode) : null) ??
      firstMeaningfulLine(result.finalMessage, failureMessage || `${reviewName} completed.`),
    jobTitle: `Grok Build ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

// Tools removed outright from read-only runs (headless-only flag). `search_replace`
// is the file-editing tool, `run_terminal_cmd` the shell — the two write paths.
// `search_tool` and `use_tool` are the MCP meta-tools: they do not write anything
// themselves, they reach a server that might. The deny rule below is intended to reject
// the MCPTool class at call time as well, so removing the two entry points does not
// depend on one rule engine getting a pattern right. Taken from
// tylersue/claude-grok-delegation, which pairs a positive allowlist with
// `--deny 'MCPTool(*)'` for exactly this reason.
//
// ⚠ That deny rule is UNVERIFIED against the current CLI, and this comment used to claim
// otherwise — "verified by injection, 2026-07-28". That date precedes CLI 1.0.0 by ten
// days, the check was never repeated against it, and this host has no MCP servers
// configured at all, so there was nothing for an injection to reach. The claim is
// withdrawn rather than reworded. Note also that the id-verification method used for the
// list below does NOT cover rule names: `--deny` and `--disallowed-tools` are separate
// namespaces, so `Bash`, `Write`, `Edit` and `MCPTool` are all still untested.
//
// Deliberately NOT disallowing `web_search`, which that project also blocks: its
// read-only mode exists for code review, ours also carries research offloads where
// looking things up is the task. `web_fetch` IS removed, and the two are not the same
// thing: search returns results, fetch retrieves whatever a URL serves, and SECURITY.md
// treats fetched content as untrusted input on the same terms as repository content.
//
// ⚠ EVERY ID BELOW WAS VERIFIED AGAINST THE INSTALLED CLI, because an id that matches
// nothing is silently inert — it reads as protection in this list and removes no tool.
// The CLI does warn (`disallowedTools entry matched nothing`), but only into the
// `--debug-file` log, which nobody reads. Method, so it can be repeated when the CLI
// moves: pass the candidates to a throwaway run with `--debug-file`, then grep that log
// for `matched nothing`, and always include a deliberate fake as a control — without one
// you cannot tell a clean result from a broken probe.
//
// Measured 2026-08-08 against grok 1.0.0 (3cd0d0cbce). Two ids that looked obvious are
// NOT real and were dropped rather than added: `delete_file` and `edit_notebook`. So was
// `spawn_subagent`, `kill_command_or_subagent` and `open_page`. Note also that the names
// the MODEL reports for its own tools are not these ids — it calls the shell
// `run_terminal_command`, which matches nothing here, while `run_terminal_cmd` is right.
const READ_ONLY_DISALLOWED_TOOLS = [
  // The two direct write paths.
  "run_terminal_cmd",
  "search_replace",
  // The MCP meta-tools: they write nothing themselves, they reach a server that might.
  "search_tool",
  "use_tool",
  // Observed being called on a read-only run, and stopped only by the deny rule below.
  "write",
  // Advertised to the model and offers a shell path of its own.
  "monitor",
  // Media generation. Every one of these puts a file on disk, which is a write however
  // pleasant the output; they were missing from this list entirely.
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video",
  // Retrieves whatever a URL serves. See the web_search note above for why only this half.
  "web_fetch",
  // Creates and removes scheduled work that outlives the run. A read-only run that leaves
  // a scheduler entry behind has changed the machine, which is the thing read-only denies.
  //
  // ⚠ ALL THREE OR NONE. `scheduler_list` is read-only and looks like padding here, but the
  // CLI's tools declare requirements on one another: remove `scheduler_create` while
  // `scheduler_list` survives and the session does not start AT ALL —
  //   Couldn't create session: Internal error: "session initialization failed: tool error:
  //   Requirements unsatisfied: [RequirementError { tool: "GrokBuild:scheduler_list", ... }]"
  // Measured 2026-08-08 against grok 1.0.0 by bisecting the list: create alone fails, delete
  // alone is fine, create+list fails naming delete, create+list+delete starts. For the whole
  // of that failure `run` is dead — not degraded, dead. The invariant is pinned in
  // tests/contract-sweep.test.mjs so the next edit meets it there and not in production.
  //
  // ⚠ AND THE GENERAL LESSON, which is bigger than the scheduler: an id can be REAL and still
  // be FATAL TO REMOVE. The `matched nothing` probe above proves an id exists. It says nothing
  // about whether the session still starts without it, because that failure happens later and
  // on a different surface. Both questions have to be asked.
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list"
];
// The control id from the method described above, kept here beside the list it guards. It is
// passed alongside the real ids by `check --verify-tools` and MUST come back reported; a probe
// that cannot see its own planted failure cannot vouch for the others either.
const TOOL_ID_PROBE_CONTROL = "grok_cc_probe_control_not_a_tool";
// Second layer: deny rules reject these tool classes even if a tool is reintroduced
// (e.g. by a subagent or a future default-tool change).
const READ_ONLY_DENY_RULES = ["Bash", "Write", "Edit", "MCPTool"];

// Connector mode (`run --connector <name>[,<name>…]`): the read-only regime with exactly one
// opening, so the model can reach the xAI managed gateway connectors the caller names (e.g.
// google_calendar, notion) that the user signed in to in the CLI or on grok.com, while the
// credential stays inside the grok process. The bridge never sees it.
//
// Derived by subtraction, never copied, so an id added to the read-only lists later is removed
// here too. Everything else stays: the shell, file writes, media generation, web_fetch, the
// scheduler, the Bash/Write/Edit deny rules and the same --sandbox profile as every other
// read-only launch (`off` when this Linux kernel has no Landlock). `--no-plan` is still
// passed and is not part of the barrier: a headless run ignores it.
const CONNECTOR_KEPT_TOOLS = ["search_tool", "use_tool"];
const CONNECTOR_DISALLOWED_TOOLS = READ_ONLY_DISALLOWED_TOOLS.filter(
  (id) => !CONNECTOR_KEPT_TOOLS.includes(id)
);
const CONNECTOR_DENY_RULES = READ_ONLY_DENY_RULES.filter((rule) => rule !== "MCPTool");
// A gateway connector name as the CLI qualifies its tools (`<server>__<tool>`): either a whole
// connector (`google_calendar`) or one exact tool of it (`google_calendar__search`), so a read
// task can be limited mechanically to read tools. Each part uses single separators only, so `__`
// appears at most once and only between server and tool, and `*` is never accepted — it would
// widen the allow rule to every connector. There is deliberately no "all": naming each connector
// is what keeps a calendar task from also being able to send mail.
const CONNECTOR_NAME_PART = "[a-z0-9]+(?:[_-][a-z0-9]+)*";
const CONNECTOR_NAME_PATTERN = new RegExp(`^${CONNECTOR_NAME_PART}(?:__${CONNECTOR_NAME_PART})?$`);
// grok 1.0.41 resolves `managed_mcps.enabled` to `!is_headless` when nothing sets it, so a
// headless process never fetches the gateway catalog unless told to (config/mod.rs,
// ManagedMcpsConfig::resolve). Both are set so the run does not depend on the remote default
// for the second one. Measured 2026-09-23: with these set the catalog arrives, 178 tools.
const CONNECTOR_CHILD_ENV = {
  GROK_MANAGED_MCPS_ENABLED: "true",
  GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "true"
};

// The allow rules are the gate: with --permission-mode default a headless run answers every
// permission request with Cancelled (xai-grok-pager/src/headless.rs), so only the named
// connectors' tools are pre-approved and a call to any other connector is refused. The mode has
// to be pinned on the command line; see `permissionMode` in executeTaskRun.
// ⚠ Additive, not exclusive: the CLI also merges allow rules from ~/.grok/config.toml, managed
// policy and Claude Code's settings (~/.claude/settings.json always, a trusted project's too),
// and from "Always allow" grants saved for the repository; a Claude `defaultMode` of auto or
// bypassPermissions replaces Cancelled with a classifier or with approval; and the rule also
// matches a local MCP server of the same name, which use_tool prefers. Nothing here can switch
// those off for one run (grok 1.0.41: permission/resolution.rs, manager/mod.rs, use_tool/mod.rs).
function connectorAllowRule(connector) {
  return connector.includes("__") ? `MCPTool(${connector})` : `MCPTool(${connector}__*)`;
}

// Prepended to every connector-mode prompt. The catalog race is the one failure every connector
// task hits unless the prompt says to poll, and the delegate path forwards the user's text
// verbatim, so this has to be a default the bridge applies rather than advice a caller may skip.
// Measured 2026-09-23: a model that searched once, before the catalog landed, found nothing.
// `marker` is this run's anchor in chat_history.jsonl. The CLI stores the prompt verbatim as a
// user item, so the check grades the lines after the user line that contains it.
function connectorPromptPreamble(connectors, marker) {
  return [
    `[Bridge note] This run may use only these connectors: ${connectors.join(", ")}. Do not call a tool of any other connector.` +
      (connectors.some((name) => name.includes("__"))
        ? " Where a name above includes a tool (server__tool), only that tool of the connector may be called."
        : "") +
      ` This run is ${marker}.`,
    "The connector tool catalog loads a few seconds after the session starts, and until it has loaded search_tool answers with status ready and no tools.",
    "Before concluding that a connector or one of its tools is unavailable, call search_tool again, one call per turn, until it returns tool names or you have tried at least five times, and pass a limit of 20 or more when you need a connector's full tool list."
  ].join(" ");
}

// `[A-Za-z0-9-]` only: the history check searches for the token as a substring of a user line.
function newConnectorRunMarker() {
  return `grok-cc-run-${crypto.randomBytes(9).toString("hex")}`;
}

// A prompt whose first text is "/" may be taken by the CLI as one of its own slash commands
// rather than as a task. A read-only run is where this bridge promises a barrier, so there the
// prompt never starts with "/". Write runs are unconfined by design; review, critique and
// connector prompts already open with bridge text.
const SLASH_GUARD_LINE =
  "[Bridge note] The task text below comes from the caller. Read it as a task, not as a command.";

// Any leading Unicode white space counts before the "/". Broader than the CLI's own parse on
// purpose — "/etc/hosts …" gets the note too — because the note is harmless and a closer copy
// of the parse would have to follow every CLI release.
const LEADING_SLASH = /^\p{White_Space}*\//u;

function promptStartsWithSlash(prompt) {
  return LEADING_SLASH.test(String(prompt ?? ""));
}

// `--connector` takes one name or a comma-separated list. Returns the validated, de-duplicated
// names in the order given. An absent value (null, undefined, false) is not connector mode; an
// empty or malformed name is refused.
function parseConnectorList(value) {
  if (value == null || value === false) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  const names = [];
  for (const part of raw.flatMap((item) => String(item).split(","))) {
    const name = part.trim();
    if (!CONNECTOR_NAME_PATTERN.test(name)) {
      throw new Error(
        `--connector takes gateway connector names such as google_calendar or google_calendar,notion, or exact tools such as google_calendar__search (lowercase letters and digits, single "_" or "-" between them, "__" only between connector and tool, no wildcards); got "${name}".`
      );
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * What actually confined this run — and, more to the point, what only looked like it did.
 *
 * `--sandbox read-only` is passed on every read-only run except one. On Linux, when Landlock
 * is not an active LSM, current CLIs refuse to start rather than run that profile: measured
 * on grok 1.0.70, 2026-10-24 (stdout empty, exit 1, the refusal sentence on stderr), and the
 * 1.0.45 source already exits 1 (xai-grok-shell config/mod.rs:1489-1495) because every profile
 * except `devbox`, `off` and a custom profile that extends `devbox` requires hook write-deny
 * (hook_write_deny.rs:21-23, xai-grok-sandbox lib.rs:54-66, the custom exemption at lib.rs:60-62).
 * That exemption does not reach the refusal: its condition is `is_custom || needs_hooks`
 * (xai-grok-shell src/config/mod.rs:1475-1480), so every custom profile still counts for it.
 * `ProfileName::Off` skips that branch (config/mod.rs:1473). The bridge passes `--sandbox off`
 * there, explicitly, so a profile set in the user's own Grok config or GROK_SANDBOX cannot
 * re-trigger the refusal. A managed requirement outranks the CLI flag
 * (agent/config.rs:632-643, requirement > CLI > env > config) and can still force a profile.
 * Whether anything enforces `read-only` where it is still passed is a property of
 * the KERNEL, not of the platform name: xAI documents Landlock on Linux and Seatbelt on macOS,
 * and Landlock is a build option that mainstream images ship without. On Windows the flag is
 * still accepted and not enforced — "not enforced" rather than "does nothing", because xAI
 * documents effects that follow from merely requesting a profile, and the public docs were
 * corrected to say so. Measured again on grok 1.0.70, 2026-10-24: the write landed, exit 0.
 *
 * ⚠ This paragraph said "is enforced by the kernel on Linux and macOS" until 2026-08-09, which
 * contradicted the probe twenty lines below it and told anyone reading the surrounding function
 * the old story first. A stale comment beside corrected code is worse than no comment: it reads
 * as the author's intent.
 *
 * Measured 2026-08-08 against grok 1.0.0 (3cd0d0cbce), no plugin involved: a direct
 * `grok -p "<create a file>" --sandbox read-only --cwd <empty dir>` exited 0 and the file
 * was there. So on Windows this is an observation now, not an inference from
 * documentation — and the CLI says nothing while it happens: stderr was zero bytes. The
 * disclosure below is OURS. Acceptance step 2b re-runs that measurement every release, and
 * fails if the write is ever refused, so this comment cannot quietly outlive its evidence.
 *
 * That was written down in
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
/**
 * Is Landlock actually ACTIVE on this kernel? Three answers, never two.
 *
 * ⚠ The LSM list says what is running; the kernel build config would only say what was
 * compiled, and those differ — `lsm=` at boot can leave Landlock out of a kernel that carries
 * it. An unreadable or unmounted securityfs is `unknown`, which is not `absent`: a probe that
 * failed to answer must not be read as a definite no, in either direction.
 *
 * ⚠ This duplicates `detect_sandbox_mechanism` in `scripts/acceptance.sh`, and the duplication
 * is not accidental — one is shell in a release gate, the other is JS at runtime, and neither
 * can call the other. If the rule changes, both change. Injectable so the three branches are
 * testable on a host that only ever produces one of them.
 *
 * GROK_CC_LANDLOCK_PROBE exists for tests. It accepts only `present`, `absent` and
 * `unknown`; any other value is ignored and the real probe runs. It does not by itself
 * select `--sandbox off`: that happens only when the platform is linux AND the answer is
 * absent. GROK_CC_CONFINEMENT_PLATFORM (`linux`, `win32` or `darwin`) is read only while
 * that probe override is one of the three values, so a test on another host can exercise
 * the Linux branch. Setting `process.platform` itself would switch the path module and
 * break the run. A platform value with no recognised probe override does not change a
 * real run.
 *
 * While that override is set, the answer was not measured. The
 * record does not say `enforced`, and a Linux read-only disclosure says the answer was
 * forced by GROK_CC_LANDLOCK_PROBE and that the host was not probed. The argv is
 * unchanged. Write mode never consults the probe, so its disclosure does not claim the
 * probe decided it.
 *
 * Off Linux the probe decides nothing, so a non-Linux record is
 * annotated only when GROK_CC_CONFINEMENT_PLATFORM decided the platform (recognised value,
 * probe override set, no explicit platform argument), and then the note names that
 * variable, not the probe. With no platform override a non-Linux record carries no note.
 */
const LANDLOCK_PROBE_ENV = "GROK_CC_LANDLOCK_PROBE";
const CONFINEMENT_PLATFORM_ENV = "GROK_CC_CONFINEMENT_PLATFORM";
const LANDLOCK_PROBE_VALUES = new Set(["present", "absent", "unknown"]);
const CONFINEMENT_PLATFORM_VALUES = new Set(["linux", "win32", "darwin"]);

function landlockProbeOverride() {
  const raw = process.env[LANDLOCK_PROBE_ENV];
  return LANDLOCK_PROBE_VALUES.has(raw) ? raw : undefined;
}

// The platform the ENV decided, or undefined. An explicit argument
// decides first, and the variable counts only while the probe override is set, so a stray
// variable cannot change a real run.
function forcedConfinementPlatform(explicit) {
  if (typeof explicit === "string" && explicit) {
    return undefined;
  }
  if (landlockProbeOverride()) {
    const forced = process.env[CONFINEMENT_PLATFORM_ENV];
    if (CONFINEMENT_PLATFORM_VALUES.has(forced)) {
      return forced;
    }
  }
  return undefined;
}

function confinementPlatform(explicit) {
  if (typeof explicit === "string" && explicit) {
    return explicit;
  }
  return forcedConfinementPlatform(explicit) ?? process.platform;
}

function detectLandlock(impl) {
  if (typeof impl === "function") {
    return impl();
  }
  const override = landlockProbeOverride();
  if (override) {
    return override;
  }
  try {
    return /landlock/i.test(fs.readFileSync("/sys/kernel/security/lsm", "utf8")) ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

// One function, evaluated at launch and again when the record is written, so the argv
// and the record agree unless the probe answer changes during the run. A task run builds
// the argv first (executeTaskRun) and the record after; a review writes the record first
// (executeReviewRun) and the argv after.
// `off` is passed explicitly: dropping the flag would let a
// sandbox profile in the user's own Grok config or GROK_SANDBOX re-trigger the refusal.
// A managed requirement outranks the CLI flag (agent/config.rs:632-643, requirement >
// CLI > env > config) and can still force a profile. ProfileName::Off skips the
// apply-or-refuse branch (config/mod.rs:1473).
function resolveReadOnlySandbox(platform, landlockImpl) {
  const host = confinementPlatform(platform);
  const landlock = host === "linux" ? detectLandlock(landlockImpl) : null;
  return {
    host,
    landlock,
    sandbox: landlock === "absent" ? "off" : "read-only"
  };
}

function readOnlySandboxProfile(platform, landlockImpl) {
  return resolveReadOnlySandbox(platform, landlockImpl).sandbox;
}

// The env override answers without reading the host. An injected
// impl is a supplied probe result and is not this note.
function forcedProbeNote(probeValue) {
  return `The answer was forced by GROK_CC_LANDLOCK_PROBE=${probeValue} and the host was not probed.`;
}

// Off Linux the probe changes neither argv, kernelSandbox nor layers, so "forced by the
// probe" would name a cause that does not exist. Where the
// record WAS forced, the deciding variable is the platform override.
function forcedPlatformNote(platformValue) {
  return `The answer was forced by GROK_CC_CONFINEMENT_PLATFORM=${platformValue} and the host was not probed.`;
}

function disclosureForForcedLinuxProbe(probeValue, sandbox) {
  const note = forcedProbeNote(probeValue);
  if (sandbox === "off") {
    return (
      "Sandbox not requested on this kernel: " + note + " Current CLIs refuse to start rather than " +
      "run --sandbox read-only without Landlock (measured on grok 1.0.70, 2026-10-24; the 1.0.45 " +
      "source already exits 1). This bridge therefore passes --sandbox off on that answer, so a " +
      "profile set in the user's own Grok config or GROK_SANDBOX cannot re-trigger the refusal. " +
      "A managed requirement still outranks the CLI flag and can force a profile. Tool removal " +
      "and deny rules are the whole barrier here."
    );
  }
  return (
    "Sandbox enforcement unverified on this kernel: " + note + " The bridge passes --sandbox " +
    "read-only on that answer. Tool removal and deny rules are the barrier being relied on."
  );
}

function describeConfinement(write, platform = undefined, landlockImpl = undefined) {
  if (write) {
    return {
      mode: "write",
      layers: [],
      kernelSandbox: "not-requested",
      disclosure:
        "Write mode: no confinement is enforced by this bridge — every tool is available " +
        "and --always-approve is set. --cwd sets the working directory and the base for " +
        "relative paths; it does not bound what the agent can read. Review the diff."
    };
  }
  // ⚠ Name the platforms that ARE enforced rather than excluding the one that is not.
  // `platform !== "win32"` reported FreeBSD, Android, AIX and anything else Node runs on as
  // kernel-enforced with no disclosure — a claim resting on nothing. xAI documents exactly
  // two mechanisms, Landlock on Linux and Seatbelt on macOS, and names none elsewhere.
  //
  // The direction of the mistake is what makes it worth fixing: an unlisted platform got the
  // reassuring answer by default, which is the wrong way round for a security descriptor.
  // Now an unknown platform is treated like Windows — barriers 1 and 2, and a disclosure
  // saying the third is unverified here rather than quietly asserting it works.
  // ⚠ AND "linux" IS NOT A MECHANISM EITHER — the same overclaim, one level in. Landlock is a
  // KERNEL CONFIG OPTION, and Raspberry Pi OS ships without it: measured 2026-08-09 on
  // 6.12.96+rpt-rpi-2712, where the write landed and the CLI said nothing. That was an older
  // CLI. Current ones refuse to start (grok 1.0.70, 2026-10-24; the 1.0.45 source already
  // does), so this descriptor says the sandbox was not requested: the bridge passes `off`.
  // This descriptor, SECURITY.md and the acceptance gate have to agree on that: docs and code
  // disagreeing about a security property is a defect in itself.
  //
  // Only a POSITIVE confirmation earns `enforced`. A probe that could not answer yields
  // `unverified` WITH a disclosure, never silence — the same asymmetry the acceptance detector
  // uses, for the same reason: saying "unknown" costs a sentence, and saying "enforced" wrongly
  // costs the reader their guard.
  const { host, landlock, sandbox } = resolveReadOnlySandbox(platform, landlockImpl);
  // An injected impl supplied the answer. The env override did not, so it must not
  // suppress `enforced` for a caller that passed a real probe result.
  const probeForced = typeof landlockImpl !== "function" ? landlockProbeOverride() : undefined;
  // ⚠ macOS DOES NOT EARN `enforced` EITHER — this was the last platform-name claim left in
  // the function. Seatbelt is part of the OS, so the mechanism exists by construction; but no
  // probe runs, this project has no Mac, and the README says macOS is unverified in real use.
  // "The mechanism exists" and "the CLI applied it" are different facts, and the first was
  // being reported as the second. An earlier fix today added a disclosure and left the enum
  // saying `enforced`, so the structured field — the one a consumer branches on — still
  // overstated it while the prose beside it admitted the assumption. Two independent reviews
  // reached this on 2026-08-09 without seeing each other's work.
  // A forced probe is not a measurement, so it cannot earn `enforced`.
  const kernelEnforced = !probeForced && sandbox === "read-only" && landlock === "present";
  const record = {
    mode: "read-only",
    layers: kernelEnforced
      ? ["disallowed-tools", "deny-rules", "sandbox"]
      : ["disallowed-tools", "deny-rules"],
    // ⚠ THE ENUM AND THE PROSE MUST AGREE, and they did not off the two axes the tests cover.
    // `requested-not-enforced` means "we asked, and we know it does not hold" — true for
    // Windows, where `read-only` is still passed and the write lands. A Linux kernel with no
    // Landlock is `not-requested`: we pass `off` rather than ask for a profile the CLI refuses
    // to start. On FreeBSD, Android or anything else, nothing was ever probed: the disclosure
    // said "unverified" while this field said "not enforced", and a machine consumer reads this
    // field. Overconfidence in the structured channel is worse than in the prose, because
    // nothing downstream re-reads the sentence. Found by a code review 2026-08-09.
    kernelSandbox: kernelEnforced
      ? "enforced"
      : sandbox === "off"
        ? "not-requested"
        : host === "win32"
          ? "requested-not-enforced"
          : "unverified",
    // Two different statements, and conflating them would be the same overclaim in a new
    // place: on Windows this is measured, and anywhere else undocumented it is unverified.
    // Saying "a write still lands" on a platform nobody has tested would be inventing
    // evidence; saying only "unverified" about Windows would be throwing evidence away.
    //
    // ⚠ macOS resolves to `unverified`, not `enforced`. Seatbelt is part of the OS rather
    // than a build option, so the mechanism is almost certainly there — but nothing here
    // probes it, this project has no Mac, and "the mechanism exists" is not the same as
    // "the CLI applied it". Only `landlock === "present"` earns `enforced` (see
    // `kernelEnforced` above); macOS gets the disclosure branch and `kernelSandbox:
    // "unverified"`, same footing as any platform whose mechanism was not confirmed.
    disclosure: probeForced && host === "linux"
      ? disclosureForForcedLinuxProbe(probeForced, sandbox)
      : kernelEnforced
      ? null
      : host === "darwin"
        ? "Sandbox enforcement unverified on macOS: Seatbelt is part of the OS, so the mechanism " +
          "is almost certainly there — but nothing here probes it, this project has no Mac, and " +
          "a mechanism existing is not the same as the CLI applying it. Tool removal and deny " +
          "rules are what the barrier actually rests on."
        : sandbox === "off"
        ? "Sandbox not requested on this kernel: Landlock is not among the active LSMs, and " +
          "current CLIs refuse to start rather than run --sandbox read-only without it " +
          "(measured on grok 1.0.70, 2026-10-24; the 1.0.45 source already exits 1). This " +
          "bridge therefore passes --sandbox off on this kernel, so a profile set in the user's " +
          "own Grok config or GROK_SANDBOX cannot re-trigger the refusal. A managed requirement " +
          "still outranks the CLI flag and can force a profile. Tool removal and deny rules are the " +
          "whole barrier here."
        : landlock === "unknown"
          ? "Sandbox enforcement unverified on this kernel: /sys/kernel/security/lsm could not " +
            "be read, so whether Landlock is active is unknown — which is not the same as it " +
            "being absent, and is reported rather than assumed either way. Tool removal and " +
            "deny rules are the barrier being relied on."
          : host === "win32"
        ? "Sandbox not enforced on this platform (win32): --sandbox read-only is passed, but a " +
          "write still lands — measured against grok 1.0.0, and the CLI itself says nothing. " +
          "Tool removal and deny rules are the whole barrier here."
        : `Sandbox enforcement unverified on this platform (${host}): xAI documents Landlock ` +
          "on Linux and Seatbelt on macOS and names no mechanism for anything else, so this " +
          "bridge does not assume one. Tool removal and deny rules are the barrier being relied " +
          "on. Nobody has measured whether the sandbox holds here — that is a gap, not a claim."
  };
  // The Linux replacement already carries the probe note. Off Linux the probe decides
  // nothing, so a note appears only when the platform override decided the host: a
  // recognised GROK_CC_CONFINEMENT_PLATFORM, the probe override set, and no explicit
  // platform argument. Otherwise the host sentence was measured and stays unannotated.
  const platformForced = forcedConfinementPlatform(platform);
  if (platformForced && host !== "linux" && record.disclosure) {
    record.disclosure = `${record.disclosure} ${forcedPlatformNote(platformForced)}`;
  }
  return record;
}

// The read-only descriptor plus the one opening connector mode makes. Its own mode, so a
// consumer branching on `mode` never reads a run that can create calendar events as read-only.
function describeConnectorConfinement(connectors, platform = undefined, landlockImpl = undefined) {
  const base = describeConfinement(false, platform, landlockImpl);
  const allowRules = connectors.map(connectorAllowRule);
  const opening =
    `Connector mode (${connectors.join(", ")}): search_tool and use_tool are available, the MCPTool deny rule is dropped, and ${allowRules.join(", ")} pre-approve${allowRules.length === 1 ? "s" : ""} every tool ${allowRules.length === 1 ? "it covers" : "they cover"}, including ones that create, send, change or delete. ` +
    "The run is pinned to --permission-mode default, so a tool of any other connector raises a permission request, which a headless run answers with Cancelled — unless your own settings already decide it, because the CLI adds them on top: allow rules in your Grok config, managed policy or Claude Code settings, \"Always allow\" grants saved for this repository, or a Claude defaultMode of auto (an LLM classifier decides instead) or bypassPermissions (everything is approved). A local MCP server with the same name as a named connector is opened too, and takes precedence. " +
    "A tool call cannot start a subagent or a workflow here: the bare Edit and Write deny rules reach those tools and are enforced before any approval mode. Measured 2026-10-15 on grok 1.0.52, the spawn was refused with \"Denied by permission policy: deny rule on edit\" and no subagents directory appeared. Children exist only in --write runs today. That refusal is a side effect of how the CLI classifies those tools, not a documented contract, so a CLI change could reopen it. Where a child does run, it shares the parent's permission rules, saved grants and approval mode and carries over the tool removal list; that inheritance is read from the CLI source and is not measured. This prompt opens with the bridge's note, so the CLI's slash dispatcher never reads it as a command. " +
    "Anything the agent can read, it can also write into a named connector that accepts text. --cwd sets the working directory and the base for relative paths. It does not bound reads: a connector run can read any file the user account can read, including ~/.ssh, ~/.claude and ~/.grok, and a prompt-injected connector payload can pull those files into the model's context and from there into a writable connector. That is the CLI's design in 1.0.41 and 1.0.45; 1.0.52 is unverified from source.";
  return {
    ...base,
    mode: "connector",
    connectors,
    allowRules,
    disclosure: base.disclosure ? `${opening} ${base.disclosure}` : opening
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

  // The kill switch again, at the last moment before a launch: the command-level check ran
  // once, and a batch line or a run that waited for a slot can start long after `disable`.
  try {
    assertBridgeEnabled();
  } catch (error) {
    try {
      slot.release();
    } catch {
    }
    throw error;
  }

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
    // handleTask already refuses --connector with --write; this keeps a request that reaches
    // here some other way from quietly running with both.
    const connectors = parseConnectorList(request.connectors);
    const connectorMode = connectors.length > 0;
    if (connectorMode && write) {
      throw new Error("--connector cannot be combined with --write.");
    }

    // Read-only enforcement, in this order of reliability:
    //  1. --disallowed-tools removes the writing/executing tools from the toolset
    //     (headless-only). Every id is verified against the installed CLI — see the list
    //     itself for why, and for how to re-verify when the registry moves.
    //  2. --deny rules reject those tool classes even if a tool slips back in.
    //  3. --sandbox comes from resolveReadOnlySandbox, the same function as the record.
    //     `read-only` where a probe confirms Landlock (`enforced`), and on Windows, macOS
    //     and an unanswered probe. A forced GROK_CC_LANDLOCK_PROBE=present still passes
    //     `read-only` but records `unverified`, because nothing was measured.
    //     Linux with Landlock absent passes `off`
    //     (`not-requested`): current CLIs refuse to start `read-only` there (grok 1.0.70,
    //     2026-10-24; cli-1.0.45 config/mod.rs:1489-1495). macOS is `unverified`. Windows
    //     is `requested-not-enforced`. Measured 2026-08-08 against grok 1.0.0 on Windows,
    //     and again on grok 1.0.70 on 2026-10-24: a direct run with the flag set wrote the
    //     file anyway, exit 0, and stderr was empty — the CLI does not say so. Acceptance
    //     step 2b re-checks the mechanism on every release.
    //
    // ⚠ Layers 1 and 2 BOTH hold on Windows. An earlier version of this comment called
    // layer 1 "the only barrier that holds on Windows", which is wrong and was wrong in
    // the one place a maintainer reads before deciding which layer is safe to drop: a live
    // 1.0.0 run showed the DENY RULES doing the stopping, and layer 1 covering neither
    // attempted path. Two independent layers, and the ordering above is about how much
    // each is trusted, not about which platforms each survives.
    // Plan mode is not the barrier. `--no-plan` is still passed because it is harmless and
    // keeps TUI parity; a headless (`-p` / `--prompt-file`) run never reads it
    // (event_loop.rs:1116 is the only consumer; HeadlessOptions has no plan field,
    // headless.rs:53-95). Plan tools stay offered, and the headless client auto-approves
    // exit_plan_mode (ext_protocol.rs:32-36), so plan mode cannot stall the run.
    // The agent's working directory is the directory the CALLER asked for, not the
    // workspace root derived from it.
    //
    // These are two different questions and they were being answered with one value. The
    // workspace root has to be the git top level so a `git init` mid-run cannot orphan the
    // job record — that is a real fix and it stays. But `runHeadlessAgent` defaults the
    // agent's `--cwd` to the same value, so `--cwd packages/auth` silently became `--cwd
    // <repo root>`: wider than requested, including under `--write`. `--cwd` is the working
    // directory, not a read boundary (absolute and `~` paths are read as given), but the
    // widening still contradicted the README's own example.
    const agentCwd = request.cwd ? path.resolve(request.cwd) : workspaceRoot;
    const headlessOptions = {
      cwd: agentCwd,
      model: request.model,
      effort: request.effort,
      maxTurns: request.maxTurns ?? undefined,
      timeoutMs: request.timeoutMs ?? undefined,
      alwaysApprove: write,
      // Connector mode pins the approval mode, because its allow rules are only a gate while
      // unmatched permission requests are refused. Without the flag the CLI takes the mode from
      // `[ui] permission_mode` in ~/.grok/config.toml, which the TUI persists when the user
      // toggles always-approve; measured 2026-09-23, a run then called a calendar tool outside
      // its allow rule. A CLI --permission-mode wins over that setting completely.
      permissionMode: connectorMode ? "default" : undefined,
      noPlan: !write,
      sandbox: write ? undefined : readOnlySandboxProfile(),
      disallowedTools: write
        ? undefined
        : connectorMode
          ? CONNECTOR_DISALLOWED_TOOLS
          : READ_ONLY_DISALLOWED_TOOLS,
      denyRules: write ? undefined : connectorMode ? CONNECTOR_DENY_RULES : READ_ONLY_DENY_RULES,
      allowRules: connectorMode ? connectors.map(connectorAllowRule) : undefined,
      env: connectorMode ? { ...process.env, ...CONNECTOR_CHILD_ENV } : undefined,
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
    // Set only when the empty-reply retry was the one term that failed, so the result
    // can say why instead of looking like a run that was never going to retry.
    let nudgeSkippedReason = "";
    // Connector runs: a marker in the prompt is this run's anchor in the session history.
    // The CLI rewrites chat_history.jsonl rather than appending, so a byte offset does not
    // stay on the turn boundary.
    const connectorMark = connectorMode
      ? { marker: newConnectorRunMarker(), since: Date.now() - 1000 }
      : null;
    const slashGuarded = !connectorMode && !write && promptStartsWithSlash(prompt);
    try {
      result = await runHeadlessAgent(workspaceRoot, {
        prompt: connectorMode
          ? `${connectorPromptPreamble(connectors, connectorMark.marker)}\n\n${prompt}`
          : slashGuarded
            ? `${SLASH_GUARD_LINE}\n\n${prompt}`
            : prompt,
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
      // side effects that already happened. Never for --connector runs either, for the same
      // reason: `write` is false there, but a connector can create, send or delete, and a
      // nudge after a partial run could, for example, create a second calendar event.
      // …and never when the bridge already knows the retry cannot help: nudging a CLI that
      // just said nobody is signed in, or that the allowance is gone, spends a second run
      // to be told the same thing. Nor after a `disable` that landed during the first run:
      // the nudge is a second CLI session, and the switch promises none will start.
      const nudgeEligible =
        !write &&
        !connectorMode &&
        result.status === 0 &&
        !RETRY_CANNOT_HELP.has(result.failureKind) &&
        !hasDeliverable(result);
      const disabledForNudge = nudgeEligible ? readDisabledFlag() : null;
      if (disabledForNudge) {
        nudgeSkippedReason = disabledForNudge.reason ?? "";
      }
      if (nudgeEligible && !disabledForNudge) {
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
          //
          // ⚠ AND CARRY THE FIRST ATTEMPT'S SPEND. Replacing the result wholesale threw away
          // the first launch's `usage`, `costTicks` and `numTurns`, so the record described TWO
          // CLI turns with ONE turn's cost — and `usageIncomplete` stayed false, because the
          // retry carried usage and nothing asked whether anything was missing. The ledger then
          // summed a confident, wrong number, and there is no quota endpoint to reconcile it
          // against; the local record is the only view there is.
          //
          // The nudge runs only for an empty exit-0 turn. Exhausting `--max-turns` is a
          // different event: the CLI prints a result envelope, writes "Error: max turns
          // reached" on stderr, and exits 1, so this branch does not run.
          // Measured 2026-08-09 against `empty-then-ok`: 2 launches, and before the sum
          // only one launch's usage was recorded.
          //
          // If either attempt reported no usage at all we cannot sum honestly, so the record
          // says so rather than presenting a partial total as complete. A launch the CLI
          // marked incomplete stays incomplete after the merge. So does a launch that
          // reported usage and no cost while the other launch reported a cost: the summed
          // ticks would otherwise look like the whole bill. Both launches unpriced, which
          // is what `empty-then-ok` emits, stays complete — the usages were measured, and
          // there is no priced side for a missing cost to contradict.
          const siblingWithheldCost =
            (launchHasUsageWithoutCost(firstResult) && launchReportedCost(retry)) ||
            (launchHasUsageWithoutCost(retry) && launchReportedCost(firstResult));
          result = {
            ...retry,
            structuredOutput: retry.structuredOutput ?? firstResult.structuredOutput ?? null,
            usage: addUsage(firstResult.usage, retry.usage),
            costTicks: addCostTicks(firstResult.costTicks, retry.costTicks),
            costUsd: addCostUsd(firstResult.costUsd, retry.costUsd),
            numTurns: addTurns(firstResult.numTurns, retry.numTurns),
            spendIncomplete: !firstResult.usage || !retry.usage,
            usageIncomplete:
              firstResult.usageIncomplete === true ||
              retry.usageIncomplete === true ||
              siblingWithheldCost
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

    // Connector runs: the result carries no tool calls, so confirm from the CLI's own session
    // history that the connector catalog ever loaded. When it did not, the reply is about an
    // empty toolbox, not about the connector, however confident it reads — measured once in
    // four runs on 2026-09-23 (see lib/connector-evidence.mjs). Nothing reached the connector
    // in that case, so the run is safe to repeat, and the failure message says so.
    let connectorCheck = null;
    if (connectorMode && result.status === 0 && !result.failureKind && result.sessionId) {
      connectorCheck = assessConnectorRun(result.sessionId, {
        cwd: agentCwd,
        marker: connectorMark.marker,
        since: connectorMark.since
      });
    }
    // A call the allow rules refused ends a headless run on the spot — the CLI reports
    // stopReason "cancelled" and nothing planned after the call runs (observed 3 of 3 on
    // 2026-09-23/24, and again on CLI 1.0.44; normal runs end "end_turn"). The text left is
    // whatever the model said before the call, so this is not a deliverable either, and
    // repeating it gets the same refusal. It is decided FIRST: otherwise a refusal-ended run
    // whose first search came back empty (the catalog race the prompt note polls through) would
    // be reported as a missing catalog, with advice to re-run that could only be refused again.
    const connectorRefused = connectorCheck?.refusedCalls > 0 && result.stopReason === "cancelled";
    const connectorUnavailable = !connectorRefused && connectorCheck?.verdict === "never-loaded";
    if (connectorUnavailable || connectorRefused) {
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
              : connectorUnavailable
                ? "connector-unavailable"
                : connectorRefused
                  ? "connector-refused"
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
    const confinement = connectorMode
      ? describeConnectorConfinement(connectors)
      : describeConfinement(write);
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
    } else if (connectorUnavailable) {
      failureParts.push(
        `The connector catalog never loaded in this run: no search_tool call found a tool and no use_tool call reached one (${connectorCheck.searchCalls} search, ${connectorCheck.useCalls} use), so nothing reached the connector and the reply is not about it. Running it again is safe and usually works.`
      );
    } else if (connectorRefused) {
      failureParts.push(
        `${connectorCheck.refusedCalls} connector call(s) were refused because no allow rule of this run covers them, and a refusal ends a headless run at once, so nothing planned after the call ran. Running the same request again gets the same refusal; name the tool in --connector if the call was intended, or leave it out of the request.`
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
    if (nudgeSkippedReason) {
      // Its own sentence, so it does not read as plain "Grok returned no output.", the
      // sentence of a run that was never going to retry. It is part of the failure
      // text and of `warnings` (the --json contract); render.mjs prints it once.
      const nudgeSkipped =
        `Automatic retry skipped: Grok Build was disabled during the run (${nudgeSkippedReason}).`;
      failureParts.push(nudgeSkipped);
      warnings.push(nudgeSkipped);
    }
    if (threadRegistrationError) {
      warnings.push(threadRegistrationError);
    }
    if (slashGuarded) {
      warnings.push(
        'The prompt began with "/", which the Grok CLI can take as one of its own slash commands. This read-only run put a note line in front of it, so the prompt no longer starts with "/".'
      );
    }
    if (connectorCheck?.verdict === "unreadable") {
      warnings.push(
        "Could not read this run's Grok session history, so whether the connector catalog loaded is unconfirmed."
      );
    } else if (connectorCheck?.verdict === "no-connector-calls" && connectorCheck.reason === "subagents") {
      // The parent's history really has no connector call, and that is not the same claim
      // as "nothing in the reply comes from a connector" once a child started during the run.
      warnings.push(
        "This connector run's parent made no search_tool or use_tool call, and a subagent started during the run whose calls are not checked."
      );
    } else if (connectorCheck?.verdict === "no-connector-calls") {
      warnings.push(
        "This connector run made no search_tool or use_tool call, so nothing in the reply comes from a connector."
      );
    } else if (connectorCheck?.verdict === "inconclusive" && !connectorRefused) {
      const why = {
        subagents: "the run spawned subagents, whose calls are in a history of their own and are not included",
        "marker-missing": "this run's marker was not found in the session history that was read",
        "no-sign": "it has connector calls with no sign either way",
        unreadable: "the session history could not be read"
      }[connectorCheck.reason] ?? "the history does not settle it";
      warnings.push(
        `This run's session history does not show whether the connector catalog loaded: ${why}.`
      );
    }
    // --max-turns exhaustion is also stopReason "cancelled" (cli-1.0.45
    // turn.rs:1712-1713, headless.rs:1397-1406) and exits non-zero, so the history was never
    // read. Saying it "does not show" a refusal asserts a check that did not happen, and it
    // must not sit beside the "could not read" warning either.
    if (connectorMode && result.stopReason === "cancelled" && !connectorRefused) {
      const historyRead = connectorCheck != null && connectorCheck.verdict !== "unreadable";
      warnings.push(
        historyRead
          ? "The run ended cancelled. In connector mode that is how a refused call ends a run, but its session history does not show one, so treat anything planned after that point as not done."
          : "The run ended cancelled and its session history was not checked."
      );
    }
    if (connectorCheck?.refusedCalls > 0 && !connectorRefused) {
      // A PolicyDeny or an unresolved MCP permission lets the turn continue (tool_calls.rs:1945,
      // :1981). connector-refused stays tied to stopReason "cancelled"; this is the other path.
      warnings.push(
        `${connectorCheck.refusedCalls} connector call(s) were refused, and the run continued.`
      );
    }
    const failureMessage = failureParts.join(" ");
    // One expression for "this run hard-failed", read by both the rendered text and the
    // summary. Two surfaces deciding that separately is precisely how they came to
    // disagree: the exit code said 2 and the rendered body carried no failure line.
    // The RETRY_CANNOT_HELP term is what covers the exit-0 envelope path, where the CLI
    // refuses the run and still exits 0 — exitStatus is already forced to 2 above, so
    // this only ever aligns the text with a verdict that was reached anyway.
    const runFailed =
      !delivered || result.status !== 0 || RETRY_CANNOT_HELP.has(failureCode);
    // Only surface failureMessage on render when the run actually failed.
    const renderFailureMessage = runFailed ? failureMessage : "";
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
        // Lets the renderer lead with the cause instead of the CLI's raw envelope. It is
        // the same code the JSON payload carries, so the text and the machine field can
        // no longer name different failures.
        failureCode,
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
      // Connector runs only: what the session history showed about the connector catalog.
      connectorCheck: connectorCheck
        ? {
            verdict: connectorCheck.verdict,
            searchCalls: connectorCheck.searchCalls,
            useCalls: connectorCheck.useCalls,
            refusedCalls: connectorCheck.refusedCalls,
            reason: connectorCheck.reason ?? null
          }
        : null,
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
      // `runs` and `show` print `summary` for a finished job. Taking it from rawOutput
      // meant a failed run summarised itself with the first line of an error envelope —
      // `{"type":"error"...`. The headline is the same sentence the rendered text now
      // opens with; falling back to failureMessage keeps an unknown code honest.
      summary: runFailed
        ? (failureHeadline(failureCode) ??
          firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`))
        : firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
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
    // The worker may already have taken the lock and marked the job running, with the grok
    // pid stored. Writing status, phase, or agentPid again rolls that back, and the worker
    // only reports agentPid when it changes, so stop then has no pid (upstream #61, 2026-10-24).
    patchJobIfActive(job.workspaceRoot, job.id, {
      pid: workerPid,
      bridgePid: workerPid,
      // The worker is spawned as process.execPath, so this is what it is. Recorded here
      // and not only in runTrackedJob because the window between spawning the worker and
      // the worker patching its own record is exactly when a user hits stop on a run they
      // just changed their mind about — and until now that was the one current-version
      // record carrying a pid with no image to check it against.
      bridgeImage: path.basename(process.execPath),
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
  assertBridgeEnabled();
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
  assertBridgeEnabled();
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
      "max-turns",
      "connector"
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
  const connectors = parseConnectorList(options.connector);
  if (connectors.length > 0) {
    // Connector mode is foreground-only and single-prompt: the background worker seals only
    // --write on its argv, and a batch would repeat a connector action once per line.
    if (options.write) {
      throw new Error(
        "--connector cannot be combined with --write: connector mode keeps the read-only toolset and opens only the named connectors."
      );
    }
    if (options.background) {
      throw new Error("--connector cannot be combined with --background.");
    }
    if (promptsFile) {
      throw new Error("--connector cannot be combined with --prompts-file.");
    }
  }

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
        connectors,
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

/**
 * Refuse before anything is resolved, before git runs, before any process is considered —
 * this must be the very first thing a gated command does, not a check woven in alongside
 * its other setup, or a caller could pay some of the cost of a run this flag exists to
 * prevent before ever reaching the refusal.
 */
function assertBridgeEnabled() {
  const flag = readDisabledFlag();
  if (flag) {
    // A synthetic fail-closed record (unreadable flag, relative
    // override) has disabledAt "unknown". Name the path; `enable` cannot always
    // clear that entry, and the reason alone is easy to miss.
    const location =
      flag.disabledAt === "unknown" && flag.path ? ` Flag: ${flag.path}.` : "";
    throw new Error(
      `Grok Build is disabled: ${flag.reason} (since ${flag.disabledAt}).${location} ` +
        "Re-enable with: node grok-bridge.mjs enable"
    );
  }
}

function handleDisable(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["reason"],
    booleanOptions: ["json"]
  });
  const reason = String(options.reason ?? "").trim();
  if (!reason) {
    throw new Error(
      'disable requires a reason: node grok-bridge.mjs disable --reason "weekly allowance exhausted"'
    );
  }
  const record = writeDisabledFlag(reason);
  outputCommandResult(
    { disabled: true, ...record },
    `Grok Build disabled: ${record.reason}\n` +
      `(since ${record.disabledAt}; flag: ${record.path})\n` +
      "From now on no run, review or critique of this bridge starts a Grok session — including runs already waiting for a slot or queued in a batch — and check --verify-tools skips its test session.\n" +
      "Re-enable with: node grok-bridge.mjs enable",
    options.json
  );
}

function handleEnable(argv) {
  const { options } = parseCommandInput(argv, { booleanOptions: ["json"] });
  const wasDisabled = clearDisabledFlag();
  outputCommandResult(
    { disabled: false, wasDisabled },
    wasDisabled ? "Grok Build re-enabled." : "Grok Build was not disabled.",
    options.json
  );
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
  // ⚠ Gated independently of handleTask, not only through it. `run-worker` is its own
  // top-level subcommand — reachable directly, not merely as an internal detail of `run` —
  // so relying on the caller's check would leave a second door into the same spend if
  // anything ever invokes this one on its own.
  //
  // Parse before the gate so a refusal can be written onto the job it was handed. Parsing
  // argv does not spend. This process is spawned with stdio ignored, so a throw here would
  // leave the record queued until the next listing called it "Orphaned".
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id", "workspace-root"],
    booleanOptions: ["write"]
  });
  let refusal = null;
  try {
    assertBridgeEnabled();
  } catch (error) {
    refusal = error;
  }
  if (refusal) {
    const rawJobId = options["job-id"];
    if (rawJobId) {
      try {
        const jobId = assertValidJobId(rawJobId);
        const workspaceRoot = options["workspace-root"] || resolveCommandWorkspace(options);
        const storedJob = readStoredJob(workspaceRoot, jobId);
        if (storedJob && storedJob.id === jobId) {
          claimJobTerminal(workspaceRoot, jobId, "failed", {
            errorMessage: refusal instanceof Error ? refusal.message : String(refusal),
            phase: "failed"
          });
        }
      } catch {
        // The refusal is the outcome. A claim that cannot land must not replace it.
      }
    }
    throw refusal;
  }

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
    // Connector mode is foreground-only, so a background worker never runs it; an edited
    // record must not be able to open connectors the parent never asked for.
    connectors: [],
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
    // Single job, so one directory scan is affordable — which makes the strand block in
    // pushJobDetails reachable in production instead of dead code. The runs LIST stays without
    // it on purpose: one scan per row turns a cheap listing into a filesystem sweep.
    const statusJob = withSubagentEvidence(snapshot.job, cwd);
    outputCommandResult({ ...snapshot, job: statusJob }, renderJobStatusReport(statusJob), options.json);
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

/**
 * Attach what Grok's own subagents produced, read from the CLI's session directory.
 *
 * Deliberately not done for the runs LIST: locating a session costs a directory scan, and
 * doing that per row turns a cheap listing into a filesystem sweep. A single job is worth
 * one scan; fifty are not.
 *
 * Failures are swallowed on purpose. This is evidence, not the result — a session
 * directory that moved, or a `GROK_HOME` on a drive that is no longer mounted, must not
 * turn a completed run into an error at display time.
 */
/**
 * ⚠ A SESSION IS NOT A RUN, and this attached one run's evidence to every run sharing a session.
 *
 * `threadId` is the Grok session id, and `--thread` and `--resume` reuse it deliberately — that
 * reuse is what makes a conversation continue across calls. But the CLI writes every subagent of
 * every turn into that one session directory, so reading it whole hands a resumed run the union
 * of all strands ever spawned in the thread, presented as its own fan-out.
 *
 * Measured 2026-08-09 against this machine's state root: **36 session ids are shared by two or
 * more runs**, one of them a thread created that same evening. A continuation that spawned
 * nothing would report "Subagents: 5 (2 failed)" and "this answer rests on 3" — the same block
 * on every run of the thread. A confident wrong count, in the feature this release headlines,
 * in exactly the category the feature exists to end. Found by a full-release code review.
 *
 * The window is the run's own lifetime, and where a bound cannot be read the strand is KEPT and
 * the result says the filter was partial: dropping evidence because a timestamp would not parse
 * is the same defect with the sign flipped.
 */
// Exported, and the collector injectable, so a test can assert that the run's OWN window
// reaches the reader. Verifying the filter in isolation is not the same as verifying that it is
// wired to the right dates — and the wiring is the part that, if it regressed, would silently
// restore a whole thread's history to every run in it.
export function withSubagentEvidence(job, cwd, collect = collectSubagentEvidence) {
  if (!job?.threadId) {
    return job;
  }
  try {
    const subagents = collect(job.threadId, {
      cwd,
      window: { from: job.startedAt ?? job.createdAt ?? null, to: job.completedAt ?? null }
    });
    return subagents ? { ...job, subagents } : job;
  } catch {
    return job;
  }
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "wait", "strands"]
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
    const waitedJob = withSubagentEvidence(snapshot.job, cwd);
    const payload = { job: waitedJob, storedJob };
    outputCommandResult(
      payload,
      renderStoredJobResult(waitedJob, storedJob, { showStrandOutput: options.strands }),
      options.json
    );
    process.exitCode = resolveStoredJobExitStatus(waitedJob, storedJob);
    return;
  }

  const { workspaceRoot, job: baseJob } = resolveResultJob(cwd, reference);
  const job = withSubagentEvidence(baseJob, cwd);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(
    payload,
    renderStoredJobResult(job, storedJob, { showStrandOutput: options.strands }),
    options.json
  );
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
    case "disable":
      handleDisable(argv);
      break;
    case "enable":
      handleEnable(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

/**
 * Resolve a path to its real location, following symlinks and Windows junctions.
 *
 * `path.resolve` normalises a path but never asks the filesystem what it points at, so a
 * link and its target normalise to two different strings. Falls back to `resolve` when the
 * file cannot be stat'ed — a path that does not exist cannot be a match anyway, and throwing
 * here would turn a startup detail into a crash.
 *
 * `realpathSync.native` is preferred on Windows because it also normalises drive-letter case,
 * which differs between how a shell spells argv[1] and how Node spells import.meta.url.
 */
function canonicalPath(candidate) {
  try {
    return (fs.realpathSync.native ?? fs.realpathSync)(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

// WHY THIS IS NOT A ONE-LINER ANY MORE.
//
// The original compared `path.resolve(argv[1])` against `fileURLToPath(import.meta.url)`.
// Reach this file through a symlink or a Windows directory junction — which needs no
// administrator rights and no developer mode — and the two strings differ, `isMain` is false,
// `main()` never runs, and the process exits 0 having printed nothing.
//
// That is the worst failure this project recognises: not an error, but a success-shaped
// silence. Measured here 2026-08-08 — direct invocation printed 3257 characters and exited 0;
// the same command through a junction printed 0 characters and exited 0. Nothing distinguishes
// it from a run that legitimately had nothing to say. Independently reported upstream as
// issue #22 by benngermin, whose second suggestion — make an unrecognised entrypoint exit
// non-zero — is the half that generalises past this bug, and is implemented below.
const SELF_PATH = canonicalPath(fileURLToPath(import.meta.url));
const ENTRY_PATH = process.argv[1] ? canonicalPath(process.argv[1]) : null;
const isMain = ENTRY_PATH !== null && ENTRY_PATH === SELF_PATH;

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
} else if (
  ENTRY_PATH !== null &&
  path.basename(ENTRY_PATH).toLowerCase() === path.basename(SELF_PATH).toLowerCase()
) {
  // Node was told to execute a file with this name, yet the two paths still disagree after
  // resolving both. Whatever the cause, this process was meant to do something and will not.
  //
  // Being imported is the ordinary reason `isMain` is false, and an import has some other
  // script in argv[1] — a test runner, a wrapper — so the basename guard leaves that path
  // untouched. Only the case that looks like execution is refused, and it is refused loudly:
  // exit 1 matches how main() reports its own failures a few lines above.
  process.stderr.write(
    "grok-bridge: refusing to run — this file was invoked as a script, but its own path " +
      `(${SELF_PATH}) does not match the entrypoint (${ENTRY_PATH}).\n` +
      "Exiting non-zero rather than doing nothing quietly, because an empty success is " +
      "indistinguishable from a run that had nothing to report.\n"
  );
  process.exitCode = 1;
}

export {
  main,
  readStoredJobWithRetry,
  isPlausibleSchemaObject,
  describeConfinement,
  describeConnectorConfinement,
  readOnlySandboxProfile,
  parseConnectorList,
  MAX_JSON_SCHEMA_CHARS,
  READ_ONLY_DISALLOWED_TOOLS,
  READ_ONLY_DENY_RULES,
  CONNECTOR_DISALLOWED_TOOLS,
  CONNECTOR_DENY_RULES,
  CONNECTOR_CHILD_ENV,
  TOOL_ID_PROBE_CONTROL,
  interpretToolIdProbe
};