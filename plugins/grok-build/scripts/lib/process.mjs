// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const executableCache = new Map();

/**
 * How long the synchronous `taskkill /T` may hold the event loop.
 *
 * Generous for the ordinary case — a tree kill is normally milliseconds — but bounded,
 * because this runs inside the wall-clock timeout handler and a blocked loop also blocks
 * the force-settle timer that is supposed to catch exactly this.
 */
const TASKKILL_TIMEOUT_MS = 4000;

/**
 * Resolve a bare command name to a directly executable file (Windows only).
 *
 * This matters beyond convenience: launching through a shell lets cmd.exe fall back to
 * ShellExecute for a name it cannot run itself, which pops up Windows' "Select an app to
 * open 'grok'" dialog. Resolving the name against PATHEXT and spawning that file
 * directly removes the shell — and the dialog — entirely.
 *
 * Returns null when no PATHEXT match exists. When an extensionless file blocks a later
 * PATHEXT hit in the same search order, returns null and sets `options.out.blockedByExtensionless`
 * so callers can fail closed instead of falling through to a bare name.
 */
/**
 * Whether spawning `command` as a bare name is safe on this platform.
 *
 * On POSIX it is: `execvp` searches PATH and never the current directory, so a bare name
 * cannot be hijacked by a file sitting in the working directory. `resolveExecutable`
 * returns null there by design, and that null means "let the OS do it", not "not found".
 *
 * On Windows it is not. `CreateProcess` searches the **current directory before PATH**,
 * and this plugin's working directory is routinely a repository somebody else wrote — that
 * is the whole point of `review`. So a null resolution on win32 means the binary was not
 * found on PATH, and spawning the bare name there hands the choice to whatever
 * `grok.exe` the reviewed repository happens to contain.
 *
 * Fail closed instead. A run that refuses to start with a readable reason costs the user a
 * PATH entry; a run that starts the wrong executable costs them the machine.
 *
 * Found 2026-07-31 by an audit pass that asked what a hostile repository could do. Nobody
 * had looked here because on a machine where `grok` is always on PATH the null branch
 * never fires.
 */
export function bareNameSpawnIsSafe(platform = process.platform) {
  return platform !== "win32";
}

/**
 * Whether this launch is the ambiguous one the guard is for.
 *
 * Only a BARE name is ambiguous. A path — absolute, or carrying a separator — names one
 * file and `CreateProcess` does not go looking elsewhere, so `resolveExecutable` returning
 * null for it means nothing. Getting this wrong would have broken every user who points
 * `GROK_BINARY` at a full path, which is exactly what the documentation tells them to do
 * when the CLI is not on PATH; the test suite caught it immediately.
 */
export function isBareCommandName(command) {
  const name = String(command ?? "");
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && !path.isAbsolute(name);
}

export function unresolvedExecutableMessage(command) {
  return (
    `Refusing to launch "${command}": it was not found on PATH, and on Windows a bare ` +
    "name is resolved against the current directory before PATH — which for this plugin " +
    "is often a repository written by someone else. Put the executable on PATH, or set " +
    "GROK_BINARY to its full path."
  );
}

export function resolveExecutable(command, env = process.env, options = {}) {
  const name = String(command ?? "").trim();
  if (!name || process.platform !== "win32") {
    return null;
  }

  const pathValue = env?.PATH ?? env?.Path ?? "";
  const cacheKey = `${name}::${pathValue}`;
  if (executableCache.has(cacheKey) && !options.out) {
    return executableCache.get(cacheKey);
  }

  const extensions = String(env?.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const hasSeparator = name.includes("/") || name.includes("\\");
  // path.delimiter is ';' on Windows and ':' on POSIX; also accept the other so a
  // mixed or WSL-style PATH does not collapse into a single bogus directory.
  const pathDirs = pathValue
    .split(/[;]+/)
    .flatMap((part) => String(part).split(path.delimiter))
    .map((dir) => dir.trim())
    .filter(Boolean);
  const bases = hasSeparator
    ? [path.resolve(name)]
    : pathDirs.map((dir) => path.join(dir, name));

  let resolved = null;
  let blockedByExtensionless = false;
  outer: for (const base of bases) {
    const candidates = path.extname(base) ? [base] : [];
    for (const ext of extensions) {
      candidates.push(`${base}${ext}`);
    }
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) {
          resolved = candidate;
          break outer;
        }
      } catch {
      }
    }
    // An extensionless file earlier in PATH wins over a later directory's .exe — that
    // is what a shell would run. We cannot exec it directly, so hand back null and
    // mark the block so callers fail closed instead of silently running a different binary.
    try {
      if (fs.statSync(base).isFile()) {
        resolved = null;
        blockedByExtensionless = true;
        break outer;
      }
    } catch {
    }
  }

  if (options.out && typeof options.out === "object") {
    options.out.blockedByExtensionless = blockedByExtensionless;
  }
  executableCache.set(cacheKey, resolved);
  return resolved;
}

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

/** .cmd/.bat files are interpreted by cmd.exe and cannot be exec'd directly. */
export function isBatchFile(filePath) {
  return /\.(cmd|bat)$/i.test(String(filePath ?? ""));
}

/**
 * Parse a common npm/cmd shim (.cmd) for a node entry script path.
 * Returns the script path when found, otherwise null.
 */
export function resolveNodeEntryFromBatch(batchPath) {
  const filePath = String(batchPath ?? "").trim();
  if (!filePath || !isBatchFile(filePath)) {
    return null;
  }
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(path.resolve(filePath));
  // npm's cmd shim: `"%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*`
  // or `"%dp0%\node.exe" "%dp0%\..\package\bin.js" %*`
  const patterns = [
    /"%dp0%\\([^"%]+\.(?:js|mjs|cjs))"/i,
    /"%dp0%\/([^"%]+\.(?:js|mjs|cjs))"/i,
    /"([^"%]+\.(?:js|mjs|cjs))"/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) {
      continue;
    }
    const relative = match[1].replace(/%~dp0%|%dp0%/gi, "").replace(/^\\+/, "");
    const candidate = path.isAbsolute(match[1])
      ? match[1]
      : path.resolve(dir, relative.replace(/\\/g, path.sep));
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
    }
  }
  return null;
}

/**
 * A JS entry point (e.g. GROK_BINARY pointing at a script) is run through the current
 * Node executable instead of the shell — no quoting or multi-line argument mangling.
 * npm's Windows .cmd shims are unwrapped to the same node+script form when possible.
 */
export function toSpawnTarget(command, args = []) {
  if (/\.(mjs|cjs|js)$/i.test(String(command ?? ""))) {
    return { command: process.execPath, args: [command, ...args], viaNode: true };
  }
  if (isBatchFile(command)) {
    const entry = resolveNodeEntryFromBatch(command);
    if (entry) {
      return { command: process.execPath, args: [entry, ...args], viaNode: true };
    }
  }
  return { command, args, viaNode: false };
}

/**
 * Whether spawn() should set shell:true. Always false: user-controlled argv must never
 * pass through cmd.exe interpolation. Batch files are either unwrapped via toSpawnTarget
 * or fail closed without a shell.
 */
export function shellForExecutable(_resolvedPath) {
  return false;
}

/** Env keys safe to forward to a grok child (plus explicit GROK_/XAI_ auth material). */
const CHILD_ENV_ALLOW = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "COMSPEC",
  "ComSpec",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  // NODE_OPTIONS and NODE_PATH are deliberately absent. They were on this list, and they
  // are the two best-known ways to make a Node process load code nobody asked for:
  // `NODE_OPTIONS=--require /tmp/x.js` runs that file before anything else, and NODE_PATH
  // redirects bare module resolution. Neither is needed to launch the CLI. Keeping them
  // meant this list asserted hardening while passing through the exact lever an attacker
  // reaches for first — and a reader who saw the allowlist would conclude more than it
  // delivered. (Audit finding, 2026-07-31; the same pass removed ANTHROPIC_/OPENAI_ from
  // the prefix list for the same reason and missed these two.)
  //
  // The parent's environment is the user's own, so this is not a remote path — it costs an
  // attacker who already has it one less step, which is the whole point of a filter.
  "NODE_ENV",
  "CLAUDE_PLUGIN_DATA",
  "GROK_CC_SESSION_ID",
  "GROK_CC_MAX_CONCURRENCY",
  "GROK_CC_SLOT_WAIT_MS",
  "GROK_BINARY",
  // Windows programs fail in obscure ways without these — missing SystemRoot in
  // particular breaks TLS and DNS in native code. They carry no user data.
  "windir",
  "SystemDrive"
]);

// Windows environment names are case-insensitive, and their casing depends on who
// spawned us: a native parent gives "SystemRoot" and "windir", MSYS/Git Bash gives
// "SYSTEMROOT" and "WINDIR". Matching case-sensitively silently dropped variables
// depending on the launcher, so both the allow list and the prefixes are folded.
const CHILD_ENV_ALLOW_FOLDED = new Set([...CHILD_ENV_ALLOW].map((key) => key.toLowerCase()));
// Only the vendor whose CLI we actually launch. This filter's first version (2026-07-26)
// also carried `anthropic_` and `openai_`, forwarding ANTHROPIC_API_KEY / OPENAI_API_KEY —
// credentials for two third parties — into a process that talks to xAI and has no use for
// them. An allowlist
// that passes a key nobody needs is not a filter, and the cost of being wrong here is
// somebody else's credential leaving the machine inside a prompt.
const CHILD_ENV_ALLOW_PREFIXES = ["grok_", "xai_"];

export function sanitizeChildEnv(env = process.env) {
  if (!env || typeof env !== "object") {
    return {};
  }
  const out = Object.create(null);
  for (const [key, value] of Object.entries(env)) {
    if (value == null) {
      continue;
    }
    const folded = key.toLowerCase();
    if (
      CHILD_ENV_ALLOW_FOLDED.has(folded) ||
      CHILD_ENV_ALLOW_PREFIXES.some((prefix) => folded.startsWith(prefix))
    ) {
      out[key] = value;
    }
  }
  return out;
}

export function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const resolution = { blockedByExtensionless: false };
  const direct = resolveExecutable(command, options.env ?? process.env, { out: resolution });
  if (resolution.blockedByExtensionless) {
    return {
      command,
      args,
      status: 1,
      signal: null,
      stdout: "",
      stderr: `Refusing to launch "${command}": an extensionless PATH entry blocks a direct PATHEXT match.`,
      error: Object.assign(new Error(`extensionless PATH block for ${command}`), {
        code: "EACCES"
      })
    };
  }
  // Not when the caller injected its own spawn: the guard exists because CreateProcess
  // searches the working directory, and an injected implementation never reaches it.
  if (
    !direct &&
    !options.spawnSyncImpl &&
    isBareCommandName(command) &&
    !bareNameSpawnIsSafe(options.platform ?? process.platform)
  ) {
    return {
      command,
      args,
      status: 1,
      signal: null,
      stdout: "",
      stderr: unresolvedExecutableMessage(command),
      error: Object.assign(new Error(`unresolved executable ${command}`), { code: "ENOENT" })
    };
  }
  const target = toSpawnTarget(direct ?? command, args);
  // Batch without a resolvable node entry: refuse shell:true with user argv.
  if (!target.viaNode && isBatchFile(target.command)) {
    return {
      command,
      args,
      status: 1,
      signal: null,
      stdout: "",
      stderr: `Refusing to shell-spawn batch file "${target.command}" with user argv; point GROK_BINARY at the .js entry or an .exe.`,
      error: Object.assign(new Error(`batch spawn refused for ${target.command}`), {
        code: "EACCES"
      })
    };
  }
  const childEnv =
    options.sanitizeEnv === false
      ? options.env
      : sanitizeChildEnv(options.env ?? process.env);
  const result = spawnSyncImpl(target.command, target.args, {
    cwd: options.cwd,
    env: childEnv,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: false,
    windowsHide: true,
    // spawnSync blocks the event loop for its whole duration. Callers that run inside a
    // timer — the wall-clock timeout being the one that matters — must be able to bound
    // that, or the very safety net meant to catch a slow kill can never fire.
    ...(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? { timeout: options.timeoutMs, killSignal: "SIGKILL" }
      : {})
  });

  const status = result.status == null ? (result.signal ? 1 : null) : result.status;

  return {
    command,
    args,
    status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.signal || result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.signal || result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

/**
 * Best-effort English reading of "that process is not there".
 *
 * This is a FALLBACK: `isTaskkillMissingExit` runs first and is locale-independent, because
 * taskkill returns 128 for a missing pid in every language. Only when the exit code is
 * something else does the text get a look at all.
 *
 * It used to carry three German phrases alongside the English ones. Two languages out of
 * the forty Windows ships in is not locale coverage, it is the appearance of it — and the
 * cost of dropping them is bounded: on a non-English Windows whose taskkill somehow exits
 * non-128 while saying the process is gone, the outcome is "attempted, not delivered". The
 * record then keeps its pids and stays stoppable, which is the safe direction and the same
 * one every other unknown takes here.
 *
 * How reachable is that at all? Measured 2026-08-01 on en-US Windows 11, against the exact
 * argument list this file uses (`/PID n /T /F`):
 *
 *     missing pid                        exit 128
 *     live pid, access denied            exit 128
 *     critical system process            exit 128
 *
 * Every case came back 128, so nothing in that sample ever reached this function. Dropping
 * `/T` does produce exit 1 — but the bridge always passes it, so that shape is not ours.
 * Four cases are not a proof of unreachability, which is why the fallback stays; they are
 * enough to say the primary check carries the traffic and this one is a backstop.
 *
 * ⚠ Do not read that as "nothing rests on it", which is what this comment said until the
 * measurement existed. `no running instance` is taskkill's `/IM` wording and cannot arise
 * from a `/PID` call at all, so that one alternative is genuinely dead for this caller.
 */
function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

/**
 * taskkill exits 128 whenever it did not kill the process — locale-independent, and
 * deliberately NOT the same question as "was the process there".
 *
 * The comment here used to read "already gone", which contradicted the measurement table
 * twenty lines above in this same file. The caller now asks the OS for liveness after a
 * 128 rather than inferring absence from it.
 */
function isTaskkillMissingExit(status) {
  return status === 128;
}

/**
 * Is this pid a corpse nobody has collected yet?
 *
 * A killed child stays in the process table until its parent reaps it, and `kill(pid, 0)`
 * on such a zombie SUCCEEDS — the pid exists. Measured under WSL2 on 2026-07-31: a child
 * killed while the parent's event loop was blocked stayed at /proc state `Z` for as long
 * as the block lasted, reporting alive the whole time. So liveness by signal alone is not
 * enough on posix, which is what this exists for.
 *
 * Every uncertain answer is "not a zombie", and that direction is the whole point. This
 * feeds kill decisions: a false "zombie" means a live process is treated as already dead
 * and stops being pursued. The previous version returned TRUE whenever `ps` errored,
 * exited non-zero or printed nothing — so on any system without `ps`, every process was a
 * corpse. It never showed on Windows because the taskkill branch returns before liveness
 * is ever consulted.
 *
 * Reaching here at all means kill(pid, 0) already succeeded, so the pid does exist; a
 * `ps` that cannot say anything therefore means "could not tell", never "gone".
 */
function isZombieProcess(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // No zombies in the posix sense, and no `ps` to ask.
    return false;
  }
  try {
    const runner = options.spawnImpl ?? spawnSync;
    const result = runner("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      return false;
    }
    const stat = String(result.stdout ?? "").trim();
    // `-o stat=` prints the state flags alone, state letter first: `Z`, `Z+`, `Ssl`, `R+`.
    // Only a leading Z is a zombie; the old `includes("Z")` was looser than the format
    // needs and matched on any flag position.
    return stat.toUpperCase().startsWith("Z");
  } catch {
    return false;
  }
}

/** true when the pid is gone — ESRCH, or a zombie nobody has reaped yet. */
export function isProcessGone(pid, killImpl = process.kill.bind(process), options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    killImpl(pid, 0);
  } catch (error) {
    return error?.code === "ESRCH";
  }
  // The pid exists, which is not the same as running. Reclaim asks this question to decide
  // whether a job's process is still out there; a corpse waiting to be collected is not,
  // and treating it as alive kept stale records unreclaimable for as long as the zombie
  // lasted. processIsAlive already made this distinction and this one did not.
  return isZombieProcess(pid, options);
}

function processIsAlive(pid, killImpl) {
  try {
    killImpl(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return !isZombieProcess(pid);
    }
    throw error;
  }
  return !isZombieProcess(pid);
}

function tryKill(killImpl, pid, signal) {
  try {
    killImpl(pid, signal);
    return { ok: true, missing: false, denied: false };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { ok: false, missing: true, denied: false };
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return { ok: false, missing: false, denied: true };
    }
    throw error;
  }
}

/**
 * Best-effort process image name for kill identity checks (Windows tasklist / posix ps).
 * Returns null when the probe fails or the pid is gone.
 */
export function readProcessImageName(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  if (platform === "win32") {
    const result = runCommandImpl(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { sanitizeEnv: false, env: options.env ?? process.env }
    );
    if (result.error || result.status !== 0) {
      return null;
    }
    const line = String(result.stdout ?? "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (!line || /INFO:|No tasks/i.test(line)) {
      return null;
    }
    // CSV: "image.exe","pid","session","session#","mem"
    const match = line.match(/^"([^"]+)"/);
    return match ? match[1] : null;
  }
  // Linux first, through the kernel's own link to the executable.
  //
  // `ps -o comm=` reports the THREAD name, and Node renames its main thread to
  // "MainThread" — measured under WSL2 on 2026-07-31, where /proc/<pid>/comm said
  // "MainThread" while /proc/<pid>/exe said /home/<user>/.local/node/bin/node. The image
  // fingerprint therefore never matched the recorded "node", every guarded kill came back
  // as `image-mismatch` with attempted:false, and on Linux that meant stop, reclaim AND
  // SessionEnd could not kill their own agents. A guard against pid reuse was refusing
  // every legitimate kill instead — silently, and only off Windows.
  //
  // The bug is specific to programs that name their threads: `sleep` reported "sleep"
  // from comm quite correctly. That is why it survived every review of this file.
  const readLinkImpl = options.readLinkImpl ?? ((target) => fs.readlinkSync(target));
  try {
    const exe = String(readLinkImpl(`/proc/${pid}/exe`) ?? "").trim();
    if (exe) {
      return exe;
    }
  } catch {
    // No /proc — macOS, BSD, or a hardened mount. Fall through.
  }

  // Without /proc, comm is the executable rather than a thread name, so it stays as the
  // fallback rather than being replaced.
  const result = runCommandImpl("ps", ["-p", String(pid), "-o", "comm="], {
    sanitizeEnv: false,
    env: options.env ?? process.env
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const name = String(result.stdout ?? "").trim();
  return name || null;
}

function imagesMatch(actual, expected) {
  const candidates = (Array.isArray(expected) ? expected : [expected])
    .filter(Boolean)
    .map((value) => path.basename(String(value)).toLowerCase());
  if (candidates.length === 0) {
    return true;
  }
  if (!actual) {
    // Probe failed: do not block kill (missing process is handled by taskkill/ESRCH).
    return true;
  }
  return candidates.includes(path.basename(String(actual)).toLowerCase());
}

/**
 * What a process this plugin started may plausibly be, when the record does not say.
 *
 * A kill target with no recorded image used to be killed with no check at all — the record
 * named a pid, and the pid was signalled. Pids are reissued, and a record can sit on disk
 * for days, so that is a "terminate an arbitrary process" primitive aimed by a stale file.
 *
 * The honest answer is that we only know two things a run ever starts: the bridge, which is
 * this interpreter, and the agent, which is the configured grok binary. Requiring the target
 * to be one of them keeps stop working for records written before images were recorded,
 * while removing the case where the pid now belongs to a text editor. The probe failing
 * still allows the kill, unchanged — that policy predates this and is about platforms where
 * the image cannot be read at all, not about records that never said.
 */
export function jobProcessImageCandidates(env = process.env) {
  const configured = env?.GROK_BINARY ? path.basename(String(env.GROK_BINARY)) : null;
  return [path.basename(process.execPath), configured, "grok", "grok.exe"].filter(Boolean);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const isAliveImpl =
    options.isAliveImpl ?? ((candidatePid) => processIsAlive(candidatePid, killImpl));
  const graceMs = options.graceMs ?? 200;

  // No expectation at all is no longer a thing a caller may ask for. Every kill site now
  // passes either the image the record wrote down or, for a record that never wrote one,
  // the two images a run can possibly have started (jobProcessImageCandidates). The old
  // `{}` meant "signal this pid, whatever it is now", which is not a decision this code is
  // entitled to make about a number it read off a file that may be days old.
  const expectedImage = options.expectedImage ?? jobProcessImageCandidates(options.env);
  // LIVENESS BEFORE IDENTITY. A pid that is already gone cannot have been recycled into
  // somebody else's process, so asking what image it wears answers nothing — and on macOS
  // it actively misleads: for a process that has already exited the probe still returns a
  // name, and that name matches no candidate. The corpse was then reported as
  // `image-mismatch` instead of `gone`, so `killTargetSettled` said no, so an aggregate
  // over two targets where one had already exited never reached `delivered: true`.
  //
  // What is measured: reordering these two questions turned three red macOS cells green.
  // What is NOT measured, and is therefore only the likely spelling: macOS `ps` is
  // documented to render a defunct process's comm in parentheses, "(node)". The fix does
  // not depend on that being the exact form.
  //
  // Found 2026-08-01, in the first CI run that ever included macOS: three macos cells red,
  // all six ubuntu and windows cells green, on a single test — "stop still succeeds when
  // one of two targets had already exited". Linux does not parenthesise, which is exactly
  // why nine years of green on two platforms said nothing about the third.
  //
  // The ordering is right independently of that quirk: identity is a question about a
  // process that EXISTS. Asked of a corpse it is at best meaningless and at worst a
  // refusal, and this function's refusals are the ones that keep pids on records forever.
  // The probe deliberately does NOT receive `runCommandImpl`. Anyone testing this function
  // wires a stub there for `taskkill`; that stub would suddenly start fielding `ps` calls
  // and answering them with kill semantics. Callers who need to steer liveness say so
  // through `isGoneImpl`.
  //
  // Note the observable side effect: this adds one `kill(pid, 0)` before anything else. It
  // signals nothing, but a test that records every call to `killImpl` will see it.
  const alreadyGone = options.isGoneImpl
    ? options.isGoneImpl(pid) === true
    : isProcessGone(pid, killImpl);
  if (!alreadyGone) {
    const image =
      options.readImageImpl?.(pid) ??
      readProcessImageName(pid, {
        platform,
        runCommandImpl,
        env: options.env
      });
    if (image && !imagesMatch(image, expectedImage)) {
      return {
        attempted: false,
        delivered: false,
        method: "image-mismatch",
        actualImage: image,
        expectedImage
      };
    }
  }

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
      sanitizeEnv: false,
      // Measured 2026-07-28: a 500ms wall-clock timeout overshot past 22 seconds and the
      // run produced no output at all. taskkill /T walks the whole tree, and under load
      // it can take many seconds; because it runs through spawnSync inside the timeout
      // handler, the event loop is blocked for that entire time — so the handler's own
      // 2s force-settle timer cannot fire either, and the wall-clock guarantee that the
      // README makes silently does not hold. Bounding the call keeps the guarantee: if
      // taskkill has not finished by then, fall through to the direct-kill path below,
      // which at least reaches the process the bridge itself spawned.
      timeoutMs: options.killTimeoutMs ?? TASKKILL_TIMEOUT_MS
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    // Exit 128 says "not killed". It does NOT say "not there" — the table above measures
    // three different reasons that all exit 128, and only one of them is a missing pid.
    // Reading it as proof of absence is the unsafe direction: `gone: true` settles the kill
    // target, so `stop` skips restoring the pids after the terminal claim has already
    // nulled them, and a live agent keeps running and spending under a record that no
    // longer names it. That is the failure this file's comments elsewhere call the worst
    // one, reached by the one code path that was confident enough not to check.
    //
    // So ask the OS which kind of 128 this was, rather than reading it off the number.
    // Liveness is authoritative where the exit code is ambiguous, and it costs one
    // `kill(pid, 0)`. Steerable through `isGoneImpl` for the same reason as above: a test
    // wiring a `runCommandImpl` stub for taskkill must not have it field `ps` calls too.
    if (!result.error && isTaskkillMissingExit(result.status)) {
      const goneAfterTaskkill = options.isGoneImpl
        ? options.isGoneImpl(pid) === true
        : isProcessGone(pid, killImpl);
      if (goneAfterTaskkill) {
        return { attempted: true, delivered: false, gone: true, method: "taskkill", result };
      }
      // Still there: taskkill refused (access denied, protected process), it did not find
      // nothing. No `gone`, so the target stays unsettled and the record keeps its pids.
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, gone: true, method: "taskkill", result };
    }

    // ENOENT: no taskkill on PATH at all. ETIMEDOUT: taskkill was started but cut off at
    // the bound so the event loop could run again. Either way the tree walk did not
    // complete, so reach the one process we know by pid.
    if (result.error?.code === "ENOENT" || result.error?.code === "ETIMEDOUT") {
      const direct = tryKill(killImpl, pid, "SIGTERM");
      if (direct.missing) {
        return { attempted: true, delivered: false, gone: true, method: "kill" };
      }
      if (result.error.code === "ETIMEDOUT") {
        // NOT delivered — and the distinction is load-bearing, not cosmetic. `stop` only
        // restores a job's kill targets when delivered is false (`patchStoppedJobKillTargets`
        // in grok-bridge.mjs — named rather than cited by line, which drifts); claim
        // delivery here and the pids are wiped from the record while descendants of a
        // half-walked tree are still alive, leaving them unreachable forever. One pid was
        // signalled, the tree was not, and that is what has to be reported.
        return { attempted: true, delivered: false, method: "kill-partial", treeKillTimedOut: true };
      }
      return { attempted: true, delivered: true, method: "kill" };
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  const methods = [];
  let signaledLiveProcess = false;

  const groupKill = tryKill(killImpl, -pid, "SIGTERM");
  if (groupKill.ok) {
    methods.push("process-group");
    signaledLiveProcess = true;
  } else if (groupKill.denied) {
    methods.push("process-group-denied");
  }

  if (isAliveImpl(pid)) {
    const directKill = tryKill(killImpl, pid, "SIGTERM");
    if (directKill.ok) {
      methods.push("process");
      signaledLiveProcess = true;
    } else if (directKill.missing) {
      return {
        attempted: true,
        delivered: signaledLiveProcess,
        // Gone only when nothing was signalled: if the group kill already landed, this
        // is an ordinary "the process died from the signal we just sent", not a target
        // that was never there.
        gone: !signaledLiveProcess,
        method: methods.join("+") || "process"
      };
    } else if (directKill.denied) {
      methods.push("process-denied");
    }
  } else if (!signaledLiveProcess) {
    return {
      attempted: true,
      delivered: false,
      gone: true,
      method: methods.join("+") || "process-group"
    };
  } else {
    return {
      attempted: true,
      delivered: true,
      method: methods.join("+") || "process-group"
    };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAliveImpl(pid)) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process" };
    }
    sleepMs(20);
  }

  if (!isAliveImpl(pid)) {
    return { attempted: true, delivered: true, method: methods.join("+") || "process" };
  }

  const groupKillHard = tryKill(killImpl, -pid, "SIGKILL");
  if (groupKillHard.ok) {
    methods.push("process-group-sigkill");
  }
  if (isAliveImpl(pid)) {
    const directKillHard = tryKill(killImpl, pid, "SIGKILL");
    if (directKillHard.ok) {
      methods.push("process-sigkill");
    } else if (directKillHard.missing) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process-sigkill" };
    }
  } else {
    return { attempted: true, delivered: true, method: methods.join("+") || "process-group-sigkill" };
  }

  sleepMs(40);
  const stillAlive = isAliveImpl(pid);
  return {
    attempted: true,
    delivered: !stillAlive,
    method: methods.join("+") || "process-sigkill"
  };
}

/**
 * Is this kill target accounted for — either killed, or verifiably not there?
 *
 * `delivered` alone is the wrong question for anyone deciding whether a job's kill
 * targets may be dropped. A process that had already exited on its own reports
 * `delivered: false` on purpose, so that a caller can tell "I killed it" apart from "it
 * was gone"; for the purpose of "is anything still running", the two are the same
 * answer. That distinction used to be made by the caller sniffing `method === "taskkill"`
 * (session-lifecycle-hook), which was right on exactly one of the five paths that mean
 * gone: the ENOENT fallback reports `method: "kill"` and the two posix paths report
 * `process-group`. So the outcome now says `gone` itself and both callers ask here.
 *
 * Everything else is NOT settled, and deliberately so — `kill-partial` (the tree walk
 * timed out), `image-mismatch` (that pid belongs to somebody else now) and every denied
 * path leave a process that may well still be alive.
 */
export function killTargetSettled(outcome) {
  if (!outcome) {
    return false;
  }
  return outcome.delivered === true || outcome.gone === true;
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
