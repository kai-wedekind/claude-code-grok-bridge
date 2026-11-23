// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import {
  binaryAvailable,
  bareNameSpawnIsSafe,
  isBareCommandName,
  resolveExecutable,
  runCommand,
  sanitizeChildEnv,
  shellForExecutable,
  terminateProcessTree,
  toSpawnTarget,
  unresolvedExecutableMessage
} from "./process.mjs";
import { acquireGlobalSlot } from "./state.mjs";

const DEFAULT_HEARTBEAT_MS = 15000;

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

export const NUDGE_PROMPT =
  "Deliver your final answer now. Do not describe your plan or intentions; execute the task and produce the complete requested result.";

const DEFAULT_BINARY = "grok";
const BINARY_ENV = "GROK_BINARY";

export function resolveGrokBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return DEFAULT_BINARY;
}

/**
 * The environment of every grok process the bridge starts: the bridge-child marker and
 * Grok's memory switched off.
 *
 * Memory is off because a bridge run is a self-contained job, and memory makes it depend on
 * runs nobody handed it. With memory on —
 * which xAI can switch on through remote settings without the user doing anything — a run can
 * store what it saw, a connector run's calendar results included, and inject it into later
 * unrelated runs in that workspace, and the capture and Dream calls behind it never reach the
 * run's usage envelope. `GROK_MEMORY=0` turns off both memory implementations for the whole
 * process, and the `/memory` toggle cannot turn it back on (cli-1.0.45
 * `crates/codegen/xai-grok-config-types/src/memory.rs:577-578, 675-700`).
 *
 * A GROK_MEMORY the user set, to any value, is left alone. `GROK_` reaches the child
 * (lib/process.mjs), so setting it is how to opt back in. Windows names are case-insensitive,
 * so there any casing counts as set; adding a second spelling would put two entries for one
 * variable into the child's environment block.
 */
export function bridgeChildEnv(env, platform = process.platform) {
  const memorySet = Object.keys(env).some(
    (key) =>
      env[key] != null &&
      (platform === "win32" ? key.toUpperCase() === "GROK_MEMORY" : key === "GROK_MEMORY")
  );
  return { ...env, GROK_CC_BRIDGE_CHILD: "1", ...(memorySet ? {} : { GROK_MEMORY: "0" }) };
}

export function runGrok(args = [], options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  return runCommand(binary, args, {
    cwd: options.cwd,
    // The same marker as the headless spawn. `check --verify-tools` starts a
    // real model session through here, and on grok 1.0.52 this plugin's hooks run inside it
    // Copied, so process.env is not mutated.
    // Memory goes off here too: that session is a bridge-launched session like any other.
    env: bridgeChildEnv(options.env ?? process.env),
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio,
    // `check --verify-tools` passes a two-minute bound, and it has to reach the runner, or the
    // probe can hang `check` indefinitely.
    timeoutMs: options.timeoutMs
  });
}

export function getGrokAvailability(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const versionStatus = binaryAvailable(binary, ["version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    const alt = binaryAvailable(binary, ["--version"], { cwd, env: options.env });
    if (!alt.available) {
      return {
        available: false,
        detail: versionStatus.detail,
        binary
      };
    }
    return {
      available: true,
      detail: alt.detail,
      binary
    };
  }
  return {
    available: true,
    detail: versionStatus.detail,
    binary
  };
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "models-probe",
    authMethod: null,
    verified: null,
    ...fields
  };
}

export function runModelsProbe(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const result = runGrok(["models"], {
    cwd,
    env: options.env,
    binary
  });

  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return buildAuthStatus({
      available: false,
      loggedIn: false,
      detail: "grok binary not found",
      source: "availability"
    });
  }

  if (result.error) {
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: result.error.message,
      source: "models-probe"
    });
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: detail || "grok models failed; not logged in or not ready",
      source: "models-probe"
    });
  }

  const stdout = (result.stdout || "").trim();

  // Exit 0 is not proof of a session. Observed on a Windows machine on 2026-07-31:
  // `grok models` exited 0 and printed "You are not authenticated." — and because loggedIn
  // was hard-wired true below, `check` answered "Status: ready" for a machine that could
  // not run anything. `ready` is the one word a caller acts on, so a false one is worse
  // than no answer at all.
  //
  // The trigger is NOT "a cold CLI", which is what this comment first guessed. Traced in
  // ~/.grok/logs/unified.jsonl on the machine that produced it: the access token had
  // expired (last refresh 23 days earlier, lifetime 6 h), and the probe landed inside the
  // OIDC refresh — `oidc refresh enter … is_expired:true` at 12:24:18.128Z, succeeding
  // 441 ms later. `grok models` read its auth state before that in-flight refresh
  // finished, reported nobody signed in, and exited 0 regardless.
  //
  // Observed twice, six hours apart, and the second time deliberately: the CLI was left
  // untouched until the access token expired, and `check` was the first call after. Same
  // shape both times, with `is_expired:true` in the log to prove the precondition rather
  // than assume it. The refresh itself measured 441 ms and 373 ms; roughly 690 ms passed
  // before the model catalog was usable. An earlier version of this comment said
  // "roughly 450–700 ms" — that lower bound sits above both measured refreshes, because
  // it was a rounding of the catalog figure rather than of the refresh.
  //
  // So: the window opens on the FIRST call after token expiry, is gone in well under a
  // second, and recurs every time the token lapses. Rare, not reproducible on demand, and
  // guaranteed to come back. Worth naming precisely, because "cold start" invites the
  // reader to file it as a startup quirk rather than a race with a known trigger.
  //
  // One hint suffices HERE, unlike the two the general predicate demands. That threshold
  // guards arbitrary TASK output, where a run that merely discusses `grok login` would
  // trip it. This is the output of a command we chose: verified against grok 0.2.117 on
  // 2026-07-31, a signed-in `grok models` prints "You are logged in with grok.com. /
  // Default model: … / Available models: …" and carries none of the hints. The observed
  // failure string carries exactly one — so the two-hint rule would have missed the very
  // case that produced this comment.
  //
  // That one-hint scan also matches the ApiKey success banner, which is
  // the line "You are using XAI_API_KEY." (cli-1.0.45 xai-grok-pager/src/models.rs:12).
  // A machine signed in with an API key was reported signed out, and the remedy told the
  // user to set the variable they had already set. The four success first lines are
  // decided before any hint is counted.
  if (modelsProbeSignedIn(stdout)) {
    return buildAuthStatus({
      available: true,
      loggedIn: true,
      detail: firstLine(stdout) || "grok models succeeded",
      source: "models-probe",
      authMethod: "grok-cli",
      verified: true
    });
  }
  if (looksLikeAuthFailure(stdout, { minHints: 1 })) {
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: firstLine(stdout) || "grok models exited 0 but reports no session",
      source: "models-probe"
    });
  }

  const loggedInHint = /logged in|available models|default model/i.test(stdout);
  return buildAuthStatus({
    available: true,
    loggedIn: true,
    detail: loggedInHint
      ? firstLine(stdout) || "grok models succeeded"
      : firstLine(stdout) || "grok models succeeded (treated as logged in)",
    source: "models-probe",
    authMethod: "grok-cli",
    verified: true
  });
}

export function getGrokAuthStatus(cwd, options = {}) {
  const availability = getGrokAvailability(cwd, options);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null
    };
  }
  return runModelsProbe(cwd, { ...options, binary: availability.binary });
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function stderrHasExactLine(stderr, exact) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .some((line) => line.trim() === exact);
}

/**
 * `grok models` success banners. The host and the model id are interpolated; the other
 * two lines are exact. cli-1.0.45 xai-grok-pager/src/models.rs:12-17.
 */
function modelsProbeSignedIn(stdout) {
  const line = firstLine(stdout);
  if (!line) {
    return false;
  }
  if (line === "You are using XAI_API_KEY.") {
    return true;
  }
  if (line === "You are authenticated via deployment key.") {
    return true;
  }
  if (/^You are logged in with .+\.$/.test(line)) {
    return true;
  }
  return /^Model '.+' is using its own API key\.$/.test(line);
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function buildHeadlessArgs(prompt, options = {}) {
  const args = [];

  if (options.resumeSessionId) {
    args.push("-r", options.resumeSessionId);
  } else if (options.continueLast) {
    args.push("-c");
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  // A prompt handed over as a FILE never touches the command line, so neither the
  // Windows ~32k argv limit nor any quoting rule can damage or truncate it. This is
  // what makes large review/critique contexts work at all.
  if (options.promptFile) {
    args.push("--prompt-file", options.promptFile);
  } else {
    args.push("-p", prompt);
  }

  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }
  // A headless run ignores this. The only consumer is the TUI
  // (event_loop.rs:1116); HeadlessOptions has no plan field (headless.rs:53-95). Still
  // passed: harmless, and it keeps parity with the TUI.
  if (options.noPlan) {
    args.push("--no-plan");
  }
  // NOTE: kebab-case --disallowed-tools REMOVES tools from the toolset (headless only);
  // camelCase --disallowedTools is merely an alias for --deny. Do not mix them up.
  if (Array.isArray(options.disallowedTools) && options.disallowedTools.length > 0) {
    args.push("--disallowed-tools", options.disallowedTools.join(","));
  }
  for (const rule of options.denyRules ?? []) {
    args.push("--deny", String(rule));
  }
  for (const rule of options.allowRules ?? []) {
    args.push("--allow", String(rule));
  }
  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.alwaysApprove) {
    args.push("--always-approve");
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.outputFormat) {
    args.push("--output-format", options.outputFormat);
  } else {
    args.push("--output-format", "plain");
  }
  if (options.jsonSchema) {
    const schemaText =
      typeof options.jsonSchema === "string" ? options.jsonSchema : JSON.stringify(options.jsonSchema);
    args.push("--json-schema", schemaText);
  }

  return args;
}

/**
 * Extract every complete top-level JSON object from a string, tolerating prefixes,
 * suffixes and concatenation. Schema-constrained runs emit ONE object per assistant
 * message, so a multi-message turn yields several concatenated objects and a plain
 * JSON.parse of the whole text fails even though the final answer is present.
 */
const MAX_SCANNED_OBJECTS = 64;
// Well below any OS command-line limit, so the switch to a prompt file happens long
// before the platform would complain.
const PROMPT_ARGV_LIMIT = 4000;

export function scanJsonObjects(text) {
  const source = String(text ?? "");
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            found.push(JSON.parse(source.slice(start, index + 1)));
            // Only the tail matters (final answer / envelope); keeping every object of a
            // multi-megabyte stream would balloon memory for no benefit.
            if (found.length > MAX_SCANNED_OBJECTS) {
              found.shift();
            }
          } catch {
          }
          start = -1;
        }
      }
    }
  }

  return found;
}

/** Last complete JSON object in a string, or null. */
export function extractLastJsonObject(text) {
  const objects = scanJsonObjects(text);
  return objects.length > 0 ? objects[objects.length - 1] : null;
}

/**
 * Envelope shape check. Model output can legitimately carry a "text" key and even
 * token-usage-like metadata, so text+usage alone must not count as a CLI envelope.
 * Real Grok CLI envelopes always include stopReason plus a session identity field
 * (sessionId and/or num_turns) — a combination model schema objects do not produce.
 */
export function looksLikeEnvelope(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(candidate, key);
  if (!has("stopReason")) {
    return false;
  }
  // usage alone is too weak (models report tokens); require session identity.
  return has("sessionId") || has("num_turns");
}

/**
 * Fallback JSON extracted from text must look like schema output, not a CLI
 * envelope or an incidental example object missing required keys.
 */
export function isPlausibleSchemaObject(obj, schema) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return false;
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(obj, key);
  if (looksLikeEnvelope(obj)) {
    return false;
  }
  // Defensive: text + session-identity without stopReason is still not schema output.
  const hasSessionIdentity = has("sessionId") || has("num_turns");
  if (has("text") && hasSessionIdentity) {
    return false;
  }
  if (schema && typeof schema === "object" && Array.isArray(schema.required) && schema.required.length > 0) {
    return schema.required.every((key) => has(key));
  }
  return true;
}

function parseCliEnvelope(stdout) {
  const objects = scanJsonObjects(stdout);
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    if (looksLikeEnvelope(objects[index])) {
      return { envelope: objects[index], parsed: true, isEnvelope: true };
    }
  }
  // Non-envelope JSON (e.g. bare schema object) is not a textless envelope: callers
  // must fall back to stdout rather than treating finalMessage as empty.
  return {
    envelope: objects.length > 0 ? objects[objects.length - 1] : null,
    parsed: objects.length > 0,
    isEnvelope: false
  };
}

export async function runHeadlessAgent(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const prompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Grok run.");
  }

  const sessionId = options.resumeSessionId
    ? options.resumeSessionId
    : options.sessionId || (options.assignSessionId === false ? null : crypto.randomUUID());

  // Hand long prompts over as a file instead of on the command line: Windows caps a
  // command line at ~32k, which is how large review/critique contexts used to die with
  // ENAMETOOLONG before the prompt ever reached the model.
  //
  // A short prompt whose first character is "-" has the same problem
  // for a different reason. `--single` / `-p` has no allow_hyphen_values
  // (cli-1.0.45 xai-grok-pager/src/app/cli.rs:471-479), so clap reads "- item" as a
  // flag and the run dies at argv parse. The prompt-file path already exists for the
  // long-prompt case and never puts the text on the command line.
  let promptFile = options.promptFile ?? null;
  let promptFileIsTemporary = false;
  const promptLeadsWithDash = prompt.startsWith("-");
  if (!promptFile && (prompt.length > PROMPT_ARGV_LIMIT || promptLeadsWithDash)) {
    promptFile = path.join(os.tmpdir(), `grok-cc-prompt-${crypto.randomUUID()}.txt`);
    try {
      // Mode at creation (not a post-write chmod): on multi-user POSIX hosts the
      // prompt content must never be world-readable, same as job logs / state.
      fs.writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
      promptFileIsTemporary = true;
    } catch (error) {
      // No silent fall back to argv. We only get here because the prompt is already
      // longer than the command line can carry, so "try argv anyway" re-creates the exact
      // failure the file handover exists to prevent — except deep inside spawn(), as an
      // ENAMETOOLONG nobody can read, instead of here where the cause is known. The
      // documentation promises long prompts travel as a file; when that is impossible,
      // saying so is the honest answer.
      promptFile = null;
      const why = promptLeadsWithDash && prompt.length <= PROMPT_ARGV_LIMIT
        ? `Prompt starts with "-" and cannot be passed as -p, because the CLI would read it as a flag, so it has to be handed over as a file — and the temporary file could not be written: ${error?.message ?? error}.`
        : `Prompt is ${prompt.length} characters, above the ${PROMPT_ARGV_LIMIT}-character command-line ` +
          `limit, so it has to be handed over as a file — and the temporary file could not be ` +
          `written: ${error?.message ?? error}. Free space in the temp directory, or pass ` +
          `--prompt-file with a path you can write.`;
      throw new Error(why);
    }
  }
  const cleanupPromptFile = () => {
    if (!promptFileIsTemporary || !promptFile) {
      return;
    }
    try {
      fs.unlinkSync(promptFile);
    } catch {
    }
    promptFileIsTemporary = false;
  };

  // Temp prompt files hold the full prompt; clean them up on termination signals too
  // (normal exit paths already call cleanup via releaseSlot). Do not own cleanup for a
  // caller-supplied --prompt-file. Re-raise the signal so exit behaviour is unchanged.
  const onTerminateSignal = (signal) => {
    cleanupPromptFile();
    detachSignalHandlers();
    try {
      process.kill(process.pid, signal);
    } catch {
      // Last resort if re-raise fails (unusual on Windows signal edge cases).
      process.exit(1);
    }
  };
  const detachSignalHandlers = () => {
    process.removeListener("SIGINT", onTerminateSignal);
    process.removeListener("SIGTERM", onTerminateSignal);
  };
  if (promptFileIsTemporary) {
    process.on("SIGINT", onTerminateSignal);
    process.on("SIGTERM", onTerminateSignal);
  }

  // Everything from here to the promise below can throw — argument assembly on a bad
  // option, slot acquisition on an unwritable state volume — and until now none of it was
  // covered: the temp prompt file was already on disk and its cleanup only became
  // reachable once `releaseSlot` existed, several statements later. A throw in between
  // left the full prompt lying in the temp directory, mode 0600 but permanent, plus two
  // signal handlers attached to a run that never started. Nothing reported it, because
  // from the caller's side the run simply failed to begin.
  let args;
  let platform;
  let detached;
  let slot = null;
  const ownsSlot = options.globalSlot !== false && !options.slot;
  try {
    args = buildHeadlessArgs(prompt, {
      ...options,
      promptFile,
      cwd: options.cwd ?? cwd,
      sessionId: options.resumeSessionId || options.continueLast ? undefined : sessionId
    });

    platform = options.platform ?? process.platform;
    detached = options.detached ?? platform !== "win32";

    // Machine-wide semaphore: bounds concurrent grok agent processes across all
    // workspaces and Claude sessions (protects the account and the local box).
    // An externally supplied slot (options.slot) is owned by the caller and must not be
    // released here — this lets one caller hold a single slot across a run plus its nudge.
    if (ownsSlot) {
      slot = await acquireGlobalSlot({
        onWait: (maxSlots) =>
          emitProgress(options.onProgress, `Waiting for a free Grok slot (max ${maxSlots} machine-wide).`, "queued"),
        onOverflow: (maxSlots) =>
          emitProgress(
            options.onProgress,
            `Queue wait exhausted (max ${maxSlots} machine-wide); starting anyway rather than failing the run.`,
            "starting"
          )
      });
    }
  } catch (error) {
    try {
      slot?.release();
    } catch {
    }
    slot = null;
    cleanupPromptFile();
    detachSignalHandlers();
    throw error;
  }

  const releaseSlot = () => {
    try {
      slot?.release();
    } catch {
    }
    slot = null;
    cleanupPromptFile();
    detachSignalHandlers();
  };

  return await new Promise((resolve, reject) => {
    let child;
    try {
      // Spawn the resolved executable when we have one: no shell, hence no Windows
      // ShellExecute fallback ("Select an app to open 'grok'").
      const childEnvSource = options.env ?? process.env;
      const sanitized =
        options.sanitizeEnv === false ? childEnvSource : sanitizeChildEnv(childEnvSource);
      // Grok 1.0.52 loads this plugin and runs its SessionStart/SessionEnd
      // inside the session this spawn starts (measured 2026-10-15). The marker is how
      // session-lifecycle-hook.mjs tells that invocation from a Claude Code one. GROK_ is
      // on sanitizeChildEnv's prefix allowlist (lib/process.mjs). Copied so a caller-supplied
      // env object, including process.env, is not mutated. bridgeChildEnv also turns Grok's
      // memory off for the run unless the user set GROK_MEMORY.
      const childEnv = bridgeChildEnv(sanitized);
      const executable = resolveExecutable(binary, childEnvSource);
      if (!executable && isBareCommandName(binary) && !bareNameSpawnIsSafe(platform)) {
        // Windows resolves a bare name against the current directory before PATH, and the
        // current directory here is routinely a repository written by somebody else. See
        // bareNameSpawnIsSafe.
        throw Object.assign(new Error(unresolvedExecutableMessage(binary)), { code: "ENOENT" });
      }
      const target = toSpawnTarget(executable ?? binary, args);
      child = spawn(target.command, target.args, {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached,
        shell: target.viaNode ? false : shellForExecutable(executable),
        windowsHide: true
      });
    } catch (error) {
      // Synchronous spawn failure would otherwise leak the slot for its full stale window.
      releaseSlot();
      reject(error);
      return;
    }

    const agentPid = child.pid ?? null;
    const startedAt = Date.now();
    emitProgress(options.onProgress, `Running grok (${binary}).`, "starting", {
      threadId: sessionId,
      agentPid,
      pid: agentPid
    });

    let stdout = "";
    let stderr = "";
    let stderrLineBuf = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let timeoutHandle = null;
    let heartbeatHandle = null;
    // Guard against a runaway agent dumping gigabytes into the worker's memory.
    // GROK_CC_STDOUT_CAP_BYTES lets tests exercise the truncation gate without
    // emitting multi-megabyte fixtures; production default stays 32 MiB.
    // The same cap bounds stderr (accumulated string + line assembler). A stderr
    // overflow is diagnostic only and must not fail an otherwise successful run.
    const envCap = Number.parseInt(
      (options.env ?? process.env).GROK_CC_STDOUT_CAP_BYTES ?? "",
      10
    );
    const stdoutCap =
      options.stdoutCapBytes ??
      (Number.isFinite(envCap) && envCap > 0 ? envCap : 32 * 1024 * 1024);
    const timeoutMs = Number(options.timeoutMs);
    const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const heartbeatMs = Number(options.heartbeatMs);
    const heartbeatEvery =
      Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : DEFAULT_HEARTBEAT_MS;

    const clearTimers = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (heartbeatHandle) {
        clearInterval(heartbeatHandle);
        heartbeatHandle = null;
      }
    };

    // Keep the prefix of stderr (spawn errors, auth failures, early diagnostics)
    // and drop the unbounded tail — a newline-free flood after the cap is noise.
    const appendStderrChunk = (chunk) => {
      if (stderrTruncated) {
        return;
      }
      const remaining = stdoutCap - stderr.length;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        return;
      }
      stderr += chunk;
    };

    const finalizeStderr = (base) => {
      if (!stderrTruncated) {
        return base;
      }
      const note = `[stderr clipped at ${stdoutCap} bytes]`;
      return base ? `${base}\n${note}` : note;
    };

    const flushStderrLines = (chunk) => {
      // Bound the line assembler with the same cap so a child that emits without
      // newlines cannot grow stderrLineBuf without limit.
      if (stderrLineBuf.length >= stdoutCap) {
        stderrTruncated = true;
        return;
      }
      let piece = chunk;
      const room = stdoutCap - stderrLineBuf.length;
      if (piece.length > room) {
        // Keep the leading bytes already buffered (and the start of this chunk)
        // so progress lines already seen stay available; drop the rest of the flood.
        piece = piece.slice(0, room);
        stderrTruncated = true;
      }
      stderrLineBuf += piece;
      let newline = stderrLineBuf.indexOf("\n");
      while (newline !== -1) {
        const line = stderrLineBuf.slice(0, newline).replace(/\r$/, "").trim();
        stderrLineBuf = stderrLineBuf.slice(newline + 1);
        if (line) {
          emitProgress(options.onProgress, line, null, {
            stderrMessage: line
          });
        }
        newline = stderrLineBuf.indexOf("\n");
      }
    };

    if (hasTimeout) {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        timedOut = true;
        emitProgress(
          options.onProgress,
          `Wall-clock timeout after ${timeoutMs}ms; stopping Grok process tree.`,
          "failed"
        );
        try {
          if (agentPid) {
            terminateProcessTree(agentPid);
          }
        } catch {
        }
        try {
          child.kill("SIGKILL");
        } catch {
        }
        // If the OS never delivers 'close' after the kill, still settle so callers
        // cannot hang past the wall-clock deadline indefinitely.
        setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimers();
          releaseSlot();
          // Settling the promise is not enough. An agent that survived the kill still
          // holds its stdio pipes, and the bridge would stay alive waiting on a child it
          // has already given up on. Let go of it explicitly.
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref?.();
          } catch {
          }
          const timeoutMessage = `Grok run exceeded wall-clock timeout of ${timeoutMs}ms.`;
          resolve({
            status: 1,
            signal: null,
            stdout,
            stderr: finalizeStderr([stderr, timeoutMessage].filter(Boolean).join("\n")),
            stdoutTruncated,
            timedOut: true,
            timeoutMs,
            sessionId,
            requestedSessionId: sessionId,
            threadId: sessionId,
            agentPid,
            finalMessage: stdout.trimEnd(),
            parsed: null,
            envelopeParsed: false,
            envelopeHasText: false,
            structuredOutput: null,
            cliSessionId: null,
            numTurns: null,
            stopReason: null,
            usage: null,
            args,
            binary
          });
        }, 2000);
      }, timeoutMs);
    }

    heartbeatHandle = setInterval(() => {
      if (settled) {
        return;
      }
      const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      emitProgress(options.onProgress, `Still running (${elapsedSec}s elapsed).`, "running");
    }, heartbeatEvery);
    heartbeatHandle.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdoutTruncated) {
        return;
      }
      // A single oversized chunk must still trip the cap: checking only
      // `stdout.length >= cap` after a full append never truncated on the first write.
      const remaining = stdoutCap - stdout.length;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      appendStderrChunk(chunk);
      flushStderrLines(chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      releaseSlot();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      if (stderrLineBuf.trim()) {
        emitProgress(options.onProgress, stderrLineBuf.trim(), null, {
          stderrMessage: stderrLineBuf.trim()
        });
        stderrLineBuf = "";
      }
      releaseSlot();
      const status = timedOut ? 1 : code ?? (signal ? 1 : 0);
      const timeoutMessage = timedOut
        ? `Grok run exceeded wall-clock timeout of ${timeoutMs}ms.`
        : "";
      emitProgress(
        options.onProgress,
        timedOut
          ? timeoutMessage
          : status === 0
            ? "Grok finished."
            : `Grok exited with status ${status}.`,
        timedOut ? "failed" : status === 0 ? "finalizing" : "failed",
        { threadId: sessionId, agentPid }
      );
      const wantsJson = (options.outputFormat ?? null) === "json";
      // The result envelope has to be known before the auth scan. A non-error envelope
      // is the model's own text (or the CLI's result object). Scanning it for
      // "grok login" and "XAI_API_KEY" would file a partial review as not-authenticated.
      const {
        envelope,
        parsed: envelopeParsed,
        isEnvelope = false
      } = wantsJson ? parseCliEnvelope(stdout) : { envelope: null, parsed: false, isEnvelope: false };
      const nonErrorEnvelope = isEnvelope && envelope?.type !== "error";
      // --max-turns exhaustion writes that envelope (stopReason "cancelled"), then
      // "Error: max turns reached" on stderr, and exits 1.
      // cli-1.0.45 headless.rs:1397-1406, xai-grok-pager-bin main.rs:2120-2128.
      const maxTurns =
        status !== 0 && nonErrorEnvelope && stderrHasExactLine(stderr, "Error: max turns reached");
      // Classify a fatal CLI error before treating the run as a generic failure: an
      // exhausted allowance is not a generic failure, and the error payload carries the
      // usage already spent.
      // stdout only: the CLI writes its fatal error envelope there. (stderr is complete by
      // now — the max-turns check above reads it — but it carries no envelope.)
      // A fatal envelope on exit 0 counts as a failure too — see findFatalErrorEnvelope.
      // Without this the allowance-exhausted payload's `promptUsage` is dropped whenever
      // the CLI forgets to set an exit code, and the tokens already spent on the refused
      // run disappear from the ledger as though the run had been free.
      const fatalEnvelope = findFatalErrorEnvelope(stdout);
      const cliFailed = status !== 0 || fatalEnvelope != null;
      const cliError = cliFailed ? parseCliErrorPayload(stdout) : null;
      // ⚠ SAY WHAT HAPPENED, IN THE PLACE A PERSON READS.
      //
      // The progress line above fires at close, before anything is classified, so it can
      // only say "Grok exited with status 1". The classification that follows lands in
      // `failureKind` -> `failureCode`, which is a machine field: `runs`, `show` and the
      // rendered output all surface `lastMessage`, and none of them surface a code.
      //
      // Measured 2026-08-02 on a real exhausted allowance: `lastMessage` said "Grok exited
      // with status 1", and `rendered` was the raw CLI envelope opening with the words
      // "Internal error". Every true word — 402, balance exhausted — sat inside that blob,
      // behind a phrase that reads as a bug in this plugin. The reporter said they would
      // have started debugging the bridge had they not known better. That is the exact
      // failure this fork exists to prevent, and the README promises the opposite: a
      // failure names which kind of failure it was.
      //
      // So emit a second progress line once the cause is known. It is not a retry and not
      // a new state; it replaces a sentence that was true but useless with one that tells
      // the reader what to do next.
      if (maxTurns) {
        emitProgress(
          options.onProgress,
          "Grok ran out of turns before finishing. The text so far is kept. " +
            "Raising --max-turns or narrowing the task is what changes the outcome; " +
            "running it again hits the same limit.",
          "failed",
          { threadId: sessionId, agentPid }
        );
      } else if (cliError?.quotaExhausted) {
        const statusNote = cliError.httpStatus === 402
          ? " (HTTP 402)"
          : cliError.httpStatus === 403
            ? " (HTTP 403)"
            : "";
        emitProgress(
          options.onProgress,
          `Grok refused the run: the account's usage balance is exhausted${statusNote}. ` +
            "Retrying cannot help until the allowance resets or credit is added. " +
            "The tokens this attempt already spent are recorded on the run.",
          "failed",
          { threadId: sessionId, agentPid }
        );
      } else if (cliFailed && !nonErrorEnvelope && looksLikeAuthFailure(stdout)) {
        emitProgress(
          options.onProgress,
          "Grok refused the run: nobody is signed in. Sign in with `grok login " +
            "--device-code` or set XAI_API_KEY. Retrying cannot help until then.",
          "failed",
          { threadId: sessionId, agentPid }
        );
      }
      const envelopeHasText = Boolean(envelope) && typeof envelope.text === "string";
      // Real envelopes without `text` carry no text deliverable. Non-envelope JSON
      // (schema-only stdout, concatenated objects) must fall back to raw stdout so the
      // answer is not discarded as an empty textless envelope.
      const finalMessage = wantsJson
        ? envelopeHasText
          ? envelope.text
          : isEnvelope
            ? ""
            : stdout.trimEnd()
        : stdout.trimEnd();
      // Prefer the CLI envelope field; for non-envelope JSON stdout there is no SO.
      const structuredOutput =
        isEnvelope && envelope && Object.prototype.hasOwnProperty.call(envelope, "structuredOutput")
          ? envelope.structuredOutput
          : null;
      // The CLI is authoritative about the session it actually used.
      const effectiveSessionId =
        isEnvelope && typeof envelope?.sessionId === "string" ? envelope.sessionId : sessionId;
      const stderrOut = timedOut
        ? [stderr, timeoutMessage].filter(Boolean).join("\n")
        : stderr;
      resolve({
        status,
        signal,
        stdout,
        stderr: finalizeStderr(stderrOut),
        stdoutTruncated,
        timedOut,
        timeoutMs: hasTimeout ? timeoutMs : null,
        sessionId: effectiveSessionId,
        requestedSessionId: sessionId,
        threadId: effectiveSessionId,
        agentPid,
        finalMessage,
        parsed: isEnvelope ? envelope : null,
        envelopeParsed: isEnvelope && envelopeParsed,
        envelopeHasText,
        structuredOutput,
        cliSessionId:
          isEnvelope && typeof envelope?.sessionId === "string" ? envelope.sessionId : null,
        numTurns: isEnvelope ? (envelope?.num_turns ?? null) : (cliError?.numTurns ?? null),
        stopReason: isEnvelope ? (envelope?.stopReason ?? null) : null,
        usage: isEnvelope ? (envelope?.usage ?? null) : (cliError?.usage ?? null),
        // Set when the run failed for a reason worth naming; the bridge maps it to a
        // failureCode so a caller can tell "retry later" from "retrying cannot help".
        // max-turns wins over a quota or auth reading of the same stdout: the envelope
        // is the model's partial text, and the stderr line is the CLI's own reason.
        failureKind: maxTurns
          ? "max-turns"
          : cliError?.quotaExhausted
            ? "quota-exhausted"
            : cliFailed && !nonErrorEnvelope && looksLikeAuthFailure(stdout)
              ? "not-authenticated"
              : null,
        failureDetail: cliError?.message ?? null,
        // The CLI reports what this run cost; keeping it is what makes a local budget
        // report possible at all (subscriptions expose no usage endpoint).
        costUsd:
          isEnvelope && typeof envelope?.total_cost_usd === "number"
            ? envelope.total_cost_usd
            : (typeof cliError?.costUsd === "number" ? cliError.costUsd : null),
        // Exact integer ticks, 1 USD = 10^10. The CLI's own documentation says summing
        // these matches the server's usage export exactly and that float dollars cannot
        // guarantee that — so a ledger built for calibration has to add up the ticks.
        costTicks:
          isEnvelope && Number.isInteger(envelope?.total_cost_usd_ticks)
            ? envelope.total_cost_usd_ticks
            : (cliError?.costTicks ?? null),
        // Set when subagent usage could not be applied, a drain timed out, or the CLI
        // withheld the cost on purpose (`cost_is_partial`). The cost fields are then
        // omitted, and token totals may under-count: a run like this is not a zero-cost
        // run, it is an unmeasured one, and the report has to say so.
        // On a fatal error the same flags arrive at the top level
        // of the error object (headless.rs:351-359), not only on a success envelope.
        usageIncomplete: isEnvelope
          ? envelope?.usage_is_incomplete === true || envelope?.cost_is_partial === true
          : cliError?.usageIncomplete === true,
        modelUsage: isEnvelope ? (envelope?.modelUsage ?? null) : (cliError?.modelUsage ?? null),
        args,
        binary
      });
    });
  });
}

/**
 * A fatal API error arrives as {"type":"error","message":"Internal error: <json>"} on
 * stdout, with the real detail JSON-encoded inside that message. Two things in there are
 * worth recovering.
 *
 * The HTTP status tells an exhausted allowance (402) apart from every other CLI failure,
 * which matters because retrying is pointless until the allowance resets — a generic
 * cli-error invites exactly the retry that cannot work.
 *
 * The `promptUsage` block accounts for the work done BEFORE the failure. The CLI reports
 * it even when the run produced no answer at all, and the figures there are not small:
 * dropping them silently understates what a week actually cost.
 */
/**
 * Did this run fail because nobody is signed in?
 *
 * Worth its own failure code rather than the `cli-error` bucket, because it is the one
 * failure whose remedy is a single command the caller can run — and because retrying is
 * as pointless as it is on an exhausted allowance. Until this existed, an unauthenticated
 * machine produced a generic "the CLI blew up", and every acceptance check that needed a
 * real run failed separately with no shared cause visible.
 *
 * Shape captured from grok 0.2.117 on 2026-07-31: a JSON envelope on STDOUT (not stderr)
 * with type "error", carrying the remedy inside its own message.
 *
 * Two independent hints are required BY DEFAULT — a task that merely discusses `grok login`
 * would trip a single-hint rule, and a false positive here sends someone to re-authenticate
 * over an unrelated failure. A miss only falls back to today's behaviour.
 *
 * `minHints` exists because that trade-off inverts when the text being judged is not a task's
 * output but a probe's. `runModelsProbe` passes 1: it is reading a model list from a command
 * it issued itself, so an unrelated mention is not a realistic input, while a miss silently
 * reports a machine as ready. Do not lower the threshold for anything that reads task output.
 */
const AUTH_FAILURE_HINTS = [/not signed in/i, /not authenticated/i, /grok login/i, /XAI_API_KEY/];

export function looksLikeAuthFailure(rawOutput, options = {}) {
  const minHints = Number.isInteger(options.minHints) && options.minHints > 0 ? options.minHints : 2;
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return false;
  }
  const envelope = scanJsonObjects(text).find((candidate) => candidate?.type === "error");
  const message = typeof envelope?.message === "string" ? envelope.message : text;
  return AUTH_FAILURE_HINTS.filter((hint) => hint.test(message)).length >= minHints;
}

/**
 * The CLI's own fatal error envelope, as opposed to an agent answer that merely discusses
 * errors. This is the discriminator that makes exit-0 failure classification safe.
 *
 * Both classifiers below used to be gated on a non-zero exit, on the assumption that a
 * fatal error always sets one. The models probe disproved that assumption on 2026-07-31 —
 * a `grok models` that landed inside an OIDC token refresh denied the session and exited 0
 * (see runModelsProbe for the trace) — and there is no reason the headless
 * path is immune, since it is the same binary. But the exit code cannot simply be dropped:
 * on a SUCCESSFUL run the output is agent prose, and a review of an authentication module
 * would carry `not signed in` and `XAI_API_KEY` quite legitimately. Classifying that as an
 * auth failure would turn a delivered answer into a false error — worse than the bug.
 *
 * The envelope separates the two — but only if it is the WHOLE output. "An error envelope
 * appears somewhere in stdout" is not the same predicate, and the difference is not
 * academic: this repository contains the signed-out envelope verbatim, in the library and
 * in the test fixture, so any honest review of it quotes the envelope inside a delivered
 * answer. The looser rule would have failed a review of this very file as
 * `not-authenticated`, which is the same class of false report the fix exists to remove.
 *
 * A fatal error is all the CLI has to say: it writes that object and nothing else. An
 * answer that mentions one always carries other text around it. So require the trimmed
 * stdout to parse as exactly that object. Being strict here is the safe direction — a miss
 * only falls back to the old exit-code behaviour, while a false hit destroys a real result.
 */
export function findFatalErrorEnvelope(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text || !text.startsWith("{")) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed?.type === "error" && typeof parsed.message === "string" ? parsed : null;
}

// cli-1.0.45 xai-grok-shell/src/sampling/error.rs:29 and :33. The apostrophe is U+2019,
// the same character the CLI interpolates. A rewritten -32003 message is this sentence;
// the code string is what the CLI sniffs in the plain-string error data before rewriting.
const FREE_USAGE_EXHAUSTED_ERROR_CODE = "subscription:free-usage-exhausted";
const FREE_USAGE_USER_MESSAGE =
  "You\u2019ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Headless attaches its spend projection on the error object itself, with uncached
 * `usage.input_tokens`. cli-1.0.45 headless.rs:351-359 via notification.rs:364-391.
 * Absent when the fatal error never reached that attach.
 */
function headlessErrorProjection(outer) {
  if (!outer || typeof outer !== "object") {
    return null;
  }
  const hasUsage = outer.usage && typeof outer.usage === "object" && !Array.isArray(outer.usage);
  const hasProjection =
    hasUsage ||
    outer.usage_is_incomplete === true ||
    outer.cost_is_partial === true ||
    Number.isInteger(outer.num_turns) ||
    Number.isInteger(outer.total_cost_usd_ticks) ||
    typeof outer.total_cost_usd === "number";
  if (!hasProjection) {
    return null;
  }
  return {
    usage: hasUsage
      ? {
          input_tokens: outer.usage.input_tokens ?? 0,
          output_tokens: outer.usage.output_tokens ?? 0,
          reasoning_tokens: outer.usage.reasoning_tokens ?? 0,
          cache_read_input_tokens: outer.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: outer.usage.cache_creation_input_tokens ?? 0,
          total_tokens: outer.usage.total_tokens ?? 0
        }
      : null,
    costTicks: Number.isInteger(outer.total_cost_usd_ticks) ? outer.total_cost_usd_ticks : null,
    costUsd: typeof outer.total_cost_usd === "number" ? outer.total_cost_usd : null,
    numTurns: finiteNumber(outer.num_turns),
    usageIncomplete: outer.usage_is_incomplete === true || outer.cost_is_partial === true,
    modelUsage: outer.modelUsage ?? null
  };
}

function promptUsageProjection(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    usage: {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      reasoning_tokens: usage.reasoningTokens ?? 0,
      cache_read_input_tokens: usage.cachedReadTokens ?? 0,
      total_tokens: usage.totalTokens ?? 0
    },
    costTicks: Number.isInteger(usage.costUsdTicks) ? usage.costUsdTicks : null,
    numTurns: finiteNumber(usage.numTurns),
    // promptUsage keeps the camelCase flags the ACP error carries. Either one means
    // the CLI withheld a complete bill.
    usageIncomplete: usage.usageIsIncomplete === true || usage.costIsPartial === true
  };
}

export function parseCliErrorPayload(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  const outer = scanJsonObjects(text).find((candidate) => candidate?.type === "error");
  const message = typeof outer?.message === "string" ? outer.message : "";
  let detail = null;
  if (message) {
    for (const candidate of scanJsonObjects(message)) {
      if (candidate && typeof candidate === "object" && ("http_status" in candidate || candidate.promptUsage)) {
        detail = candidate;
        break;
      }
    }
  }
  const projected = headlessErrorProjection(outer);
  const fromPrompt = promptUsageProjection(detail?.promptUsage);
  if (!outer && !detail) {
    return null;
  }

  const detailMessage = typeof detail?.message === "string" ? detail.message : "";
  const httpStatus = finiteNumber(detail?.http_status);
  const combined = `${message}\n${detailMessage}`;
  // 402 is the measured allowance refusal. Free-usage exhaustion arrives as the
  // rewritten user message (or the code string, if the rewrite did not run).
  // A 403 counts only with the legacy credit wording — other 403s are not quota.
  // cli-1.0.45 error.rs:29-33, headless.rs:1413-1418, billing.rs:60-71.
  const quotaExhausted = Boolean(
    httpStatus === 402 ||
      /balance exhausted/i.test(detailMessage) ||
      /balance exhausted/i.test(message) ||
      (httpStatus === 403 && /run out of credits/i.test(combined)) ||
      combined.includes(FREE_USAGE_EXHAUSTED_ERROR_CODE) ||
      message === FREE_USAGE_USER_MESSAGE ||
      detailMessage === FREE_USAGE_USER_MESSAGE
  );
  // An auth envelope is type "error" and carries none of this. Returning an object
  // for it would put the remedy text into failureDetail and change a path that
  // already classifies itself from the hints. Only a payload with a status, a quota
  // sentence, or a spend projection is this function's business.
  if (!projected && !fromPrompt && httpStatus == null && !quotaExhausted) {
    return null;
  }

  const usage = projected?.usage ?? fromPrompt?.usage ?? null;
  // The projection is authoritative when it is present, including when it omitted the
  // ticks. Falling through to promptUsage would record a bill `cost_is_partial` withheld.
  // cli-1.0.45 notification.rs:377-392.
  const costTicks = projected ? projected.costTicks : (fromPrompt?.costTicks ?? null);
  // The CLI reports the turn count inside the error payload too, and dropping it here
  // was losing it exactly where it is hardest to get again. Measured 2026-08-02 on a
  // real 402: `promptUsage.numTurns` and `num_turns` both said 1, and the job record
  // still showed `numTurns: null`, because the envelope path is the only one that read
  // it and a fatal error produces no envelope. Turn count is the live diagnostic for
  // whether a run did any work before it stopped; a failure path is the worst place to
  // have it missing.
  // Both spellings on the detail object, because the chain reached only one of them: the
  // captured fixtures happen to carry `promptUsage.numTurns`, so a payload that put a
  // camelCase `numTurns` on the detail and no usage block would have stored null while
  // the count sat right there. The headless projection's `num_turns` wins when it is
  // present, because that is the uncached bill the CLI attached on purpose.
  const numTurns = projected?.numTurns
    ?? fromPrompt?.numTurns
    ?? finiteNumber(detail?.num_turns)
    ?? finiteNumber(detail?.numTurns);

  return {
    httpStatus,
    message: detailMessage || message,
    quotaExhausted,
    usage,
    costTicks,
    costUsd: projected?.costUsd ?? null,
    numTurns,
    usageIncomplete: projected?.usageIncomplete === true || fromPrompt?.usageIncomplete === true,
    modelUsage: projected?.modelUsage ?? null
  };
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }

  const text = String(rawOutput).trim();

  try {
    return {
      ...fallback,
      parsed: JSON.parse(text),
      parseError: null,
      rawOutput: text
    };
  } catch {
  }

  // Schema-constrained runs emit ONE JSON object per assistant message, so a
  // multi-message turn arrives as concatenated objects that strict parsing rejects
  // even though the final answer is complete. Take the last complete object.
  const lastObject = extractLastJsonObject(text);
  if (lastObject && typeof lastObject === "object") {
    return {
      ...fallback,
      parsed: lastObject,
      parseError: null,
      rawOutput: text
    };
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(fenced[1].trim()),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(text.slice(start, end + 1)),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Could not parse structured JSON from Grok output.",
    rawOutput: text
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export function schemaInstructionsFromPath(schemaPath) {
  if (!schemaPath || !fs.existsSync(schemaPath)) {
    return "";
  }
  const schema = readJsonFile(schemaPath);
  return [
    "Return only valid JSON matching this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput, schemaInstructions = "" }) {
  const parts = [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files.",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or read-only inspection.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)",
    schemaInstructions ? `\n${schemaInstructions}` : ""
  ];
  return parts.filter((line) => line !== undefined).join("\n");
}
