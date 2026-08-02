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

export function runGrok(args = [], options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  return runCommand(binary, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio
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
  let promptFile = options.promptFile ?? null;
  let promptFileIsTemporary = false;
  if (!promptFile && prompt.length > PROMPT_ARGV_LIMIT) {
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
      throw new Error(
        `Prompt is ${prompt.length} characters, above the ${PROMPT_ARGV_LIMIT}-character command-line ` +
          `limit, so it has to be handed over as a file — and the temporary file could not be ` +
          `written: ${error?.message ?? error}. Free space in the temp directory, or pass ` +
          `--prompt-file with a path you can write.`
      );
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
      const childEnv =
        options.sanitizeEnv === false ? childEnvSource : sanitizeChildEnv(childEnvSource);
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
      // Classify a fatal CLI error before the envelope logic: an exhausted allowance is
      // not a generic failure, and the error payload carries the usage already spent.
      // stdout only: the CLI writes its fatal error envelope there, and the stderr
      // accumulator is not initialised yet at this point in the close handler.
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
      if (cliError?.quotaExhausted) {
        emitProgress(
          options.onProgress,
          "Grok refused the run: the account's usage balance is exhausted (HTTP 402). " +
            "Retrying cannot help until the allowance resets or credit is added. " +
            "The tokens this attempt already spent are recorded on the run.",
          "failed",
          { threadId: sessionId, agentPid }
        );
      } else if (cliFailed && looksLikeAuthFailure(stdout)) {
        emitProgress(
          options.onProgress,
          "Grok refused the run: nobody is signed in. Sign in with `grok login " +
            "--device-code` or set XAI_API_KEY. Retrying cannot help until then.",
          "failed",
          { threadId: sessionId, agentPid }
        );
      }
      const {
        envelope,
        parsed: envelopeParsed,
        isEnvelope = false
      } = wantsJson ? parseCliEnvelope(stdout) : { envelope: null, parsed: false, isEnvelope: false };
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
        failureKind: cliError?.quotaExhausted
          ? "quota-exhausted"
          : cliFailed && looksLikeAuthFailure(stdout)
            ? "not-authenticated"
            : null,
        failureDetail: cliError?.message ?? null,
        // The CLI reports what this run cost; keeping it is what makes a local budget
        // report possible at all (subscriptions expose no usage endpoint).
        costUsd:
          isEnvelope && typeof envelope?.total_cost_usd === "number" ? envelope.total_cost_usd : null,
        // Exact integer ticks, 1 USD = 10^10. The CLI's own documentation says summing
        // these matches the server's usage export exactly and that float dollars cannot
        // guarantee that — so a ledger built for calibration has to add up the ticks.
        costTicks:
          isEnvelope && Number.isInteger(envelope?.total_cost_usd_ticks)
            ? envelope.total_cost_usd_ticks
            : (cliError?.costTicks ?? null),
        // Set when subagent usage could not be applied or a drain timed out. The cost
        // fields are then omitted, and token totals may under-count: a run like this is
        // not a zero-cost run, it is an unmeasured one, and the report has to say so.
        usageIncomplete: isEnvelope ? envelope?.usage_is_incomplete === true : false,
        modelUsage: isEnvelope ? (envelope?.modelUsage ?? null) : null,
        args,
        binary
      });
    });
  });
}

export function runImport(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const args = ["import"];
  if (options.list) {
    args.push("--list");
  }
  if (options.sourcePath) {
    args.push(options.sourcePath);
  }
  if (options.json !== false) {
    args.push("--json");
  }

  emitProgress(options.onProgress, "Importing Claude session into Grok.", "transferring");

  const result = runGrok(args, {
    cwd,
    env: options.env,
    binary
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(detail || "grok import failed");
  }

  const raw = (result.stdout || "").trim();
  let parsed = null;
  let sessionId = null;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      parsed = obj;
      sessionId =
        obj.sessionId ??
        obj.session_id ??
        obj.id ??
        obj.importedSessionId ??
        obj.threadId ??
        sessionId;
    } catch {
    }
  }

  if (!sessionId) {
    const match = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
    if (match) {
      sessionId = match[0];
    }
  }

  emitProgress(options.onProgress, sessionId ? `Imported session ${sessionId}.` : "Import completed.", "completed", {
    threadId: sessionId
  });

  return {
    status: 0,
    stdout: raw,
    stderr: result.stderr,
    sessionId,
    threadId: sessionId,
    parsed,
    resumeCommand: sessionId ? `grok -r ${sessionId}` : null
  };
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

export function parseCliErrorPayload(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text.includes("http_status") && !text.includes("balance exhausted")) {
    return null;
  }

  let detail = null;
  const outer = scanJsonObjects(text).find((candidate) => candidate?.type === "error");
  const message = typeof outer?.message === "string" ? outer.message : text;
  for (const candidate of scanJsonObjects(message)) {
    if (candidate && typeof candidate === "object" && "http_status" in candidate) {
      detail = candidate;
      break;
    }
  }
  if (!detail) {
    return null;
  }

  const usage = detail.promptUsage ?? null;
  return {
    httpStatus: Number.isFinite(Number(detail.http_status)) ? Number(detail.http_status) : null,
    message: typeof detail.message === "string" ? detail.message : message,
    quotaExhausted:
      Number(detail.http_status) === 402 || /balance exhausted/i.test(String(detail.message ?? "")),
    usage: usage
      ? {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          reasoning_tokens: usage.reasoningTokens ?? 0,
          cache_read_input_tokens: usage.cachedReadTokens ?? 0,
          total_tokens: usage.totalTokens ?? 0
        }
      : null,
    costTicks: Number.isInteger(usage?.costUsdTicks) ? usage.costUsdTicks : null,
    // The CLI reports the turn count inside the error payload too, and dropping it here
    // was losing it exactly where it is hardest to get again. Measured 2026-08-02 on a
    // real 402: `promptUsage.numTurns` and `num_turns` both said 1, and the job record
    // still showed `numTurns: null`, because the envelope path is the only one that read
    // it and a fatal error produces no envelope. Turn count is the live diagnostic for
    // whether a run did any work before it stopped; a failure path is the worst place to
    // have it missing.
    // Both spellings on the outer object, because the chain reached only one of them: the
    // captured fixtures happen to carry `promptUsage.numTurns`, so a payload that put a
    // camelCase `numTurns` on the detail and no usage block would have stored null while
    // the count sat right there. Cheap to accept, and nothing else distinguishes them.
    numTurns: Number.isFinite(Number(usage?.numTurns))
      ? Number(usage.numTurns)
      : Number.isFinite(Number(detail?.num_turns))
        ? Number(detail.num_turns)
        : Number.isFinite(Number(detail?.numTurns))
          ? Number(detail.numTurns)
          : null
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
