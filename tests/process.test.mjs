// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveNodeEntryFromBatch,
  runCommand,
  sanitizeChildEnv,
  shellForExecutable,
  terminateProcessTree,
  toSpawnTarget
} from "../plugins/grok-build/scripts/lib/process.mjs";

test("shellForExecutable never enables shell (user argv must not hit cmd.exe)", () => {
  assert.equal(shellForExecutable(null), false);
  assert.equal(shellForExecutable(undefined), false);
  assert.equal(shellForExecutable(""), false);
  assert.equal(shellForExecutable("C:\\\\tools\\\\grok.exe"), false);
  assert.equal(shellForExecutable("/usr/local/bin/grok"), false);
  assert.equal(shellForExecutable("C:\\\\tools\\\\run.cmd"), false);
  assert.equal(shellForExecutable("C:\\\\tools\\\\run.bat"), false);
  assert.equal(shellForExecutable("C:\\\\tools\\\\Run.BAT"), false);
  assert.equal(shellForExecutable("script.CMD"), false);
  assert.equal(shellForExecutable("notes.txt"), false);
});

test("toSpawnTarget unwraps npm-style .cmd shims to node + script", () => {
  const dir = makeTempDir();
  const scriptPath = path.join(dir, "cli.js");
  fs.writeFileSync(scriptPath, "console.log('ok')\n", "utf8");
  const cmdPath = path.join(dir, "grok.cmd");
  fs.writeFileSync(
    cmdPath,
    [
      "@ECHO off",
      'SET "_prog=node"',
      `endLocal & "%_prog%"  "%dp0%\\cli.js" %*`
    ].join("\r\n"),
    "utf8"
  );

  const target = toSpawnTarget(cmdPath, ["-p", "hi"]);
  assert.equal(target.viaNode, true);
  assert.equal(target.command, process.execPath);
  assert.equal(target.args[0], scriptPath);
  assert.deepEqual(target.args.slice(1), ["-p", "hi"]);
  assert.equal(resolveNodeEntryFromBatch(cmdPath), scriptPath);
});

test("runCommand refuses unresolved batch files without shelling out", () => {
  const dir = makeTempDir();
  const cmdPath = path.join(dir, "opaque.cmd");
  fs.writeFileSync(cmdPath, "@echo off\r\necho hi\r\n", "utf8");
  const result = runCommand(cmdPath, ["user-arg"], {
    spawnSyncImpl() {
      throw new Error("spawn must not be reached for opaque batch");
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to shell-spawn batch/i);
});

test("sanitizeChildEnv drops unrelated secrets while keeping PATH and GROK_ keys", () => {
  const sanitized = sanitizeChildEnv({
    PATH: "C:\\bin",
    GROK_BINARY: "grok",
    XAI_API_KEY: "secret-value",
    AWS_SECRET_ACCESS_KEY: "should-drop",
    RANDOM_TOKEN: "nope",
    CLAUDE_PLUGIN_DATA: "C:\\data"
  });
  assert.equal(sanitized.PATH, "C:\\bin");
  assert.equal(sanitized.GROK_BINARY, "grok");
  assert.equal(sanitized.XAI_API_KEY, "secret-value");
  assert.equal(sanitized.CLAUDE_PLUGIN_DATA, "C:\\data");
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "RANDOM_TOKEN"), false);
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

// A localised taskkill is still read correctly without the text being understood — exit
// 128 is locale-independent. What 128 does NOT settle is whether the process was there,
// because a missing pid and a live pid the caller may not touch both exit 128. So the
// verdict comes from liveness, and these two tests differ only in that answer.
test("taskkill exit 128 on a pid that really is gone reports gone, whatever the locale says", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    isGoneImpl: () => true,
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        // Deliberately a message this code cannot parse.
        stdout: "<<localised message this code does not parse>>",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.gone, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
});

test("taskkill exit 128 on a pid that is still alive does NOT report gone", () => {
  // Measured 2026-08-01 on en-US Windows 11 with this exact argument list: `taskkill
  // /PID 4 /T /F` on a protected process exits 128 saying "Access is denied", the same
  // code a missing pid produces. Reading that as absence lets `killTargetSettled` settle
  // a target whose process is still running, `stop` then skips the pid restore, and the
  // record stops naming an agent that keeps spending. This is the regression guard.
  let liveness = 0;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    isGoneImpl() {
      liveness += 1;
      return false;
    },
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process with PID 1234 could not be terminated.",
        stderr: "Reason: Access is denied.",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.gone, undefined, "a refused kill is not a missing process");
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  // Once before the image check, once after taskkill — the second one is the fix.
  assert.ok(liveness >= 2, "liveness must be re-asked after taskkill returns 128");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  // Liveness is steered through `killImpl` rather than `isGoneImpl` on purpose: an
  // `isGoneImpl` that answers "gone" would hand the function the very conclusion under
  // test, and the derivation — 128, then ask the OS, then report gone — would move into
  // the stub. Throwing ESRCH makes the real `isProcessGone` do the deriving, which is the
  // part that has to keep working. Determinism is still required; the pid is a fixture and
  // the real answer for it is host-dependent.
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    killImpl: () => {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    },
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: 'ERROR: The process "1234" not found.',
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.gone, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree refuses kill when process image does not match expected", () => {
  const outcome = terminateProcessTree(5555, {
    platform: "win32",
    // The process EXISTS — that is the only case in which the image question arises.
    // Since 2026-08-01 terminateProcessTree skips it for a corpse, and 5555 exists on no
    // test machine.
    isGoneImpl: () => false,
    expectedImage: "node.exe",
    readImageImpl: () => "malware.exe",
    runCommandImpl() {
      throw new Error("taskkill must not run on image mismatch");
    }
  });
  assert.equal(outcome.attempted, false);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "image-mismatch");
});

test("terminateProcessTree uses process-group SIGTERM then escalates to SIGKILL on posix", () => {
  const signals = [];
  let alive = true;
  const outcome = terminateProcessTree(4321, {
    platform: "darwin",
    graceMs: 40,
    isAliveImpl: () => alive,
    killImpl(pid, signal) {
      signals.push({ pid, signal });
      if (signal === 0) {
        if (!alive) {
          const error = new Error("no such process");
          error.code = "ESRCH";
          throw error;
        }
        return true;
      }
      if (signal === "SIGKILL") {
        alive = false;
      }
    }
  });

  assert.ok(signals.some((entry) => entry.pid === -4321 && entry.signal === "SIGTERM"));
  assert.ok(signals.some((entry) => entry.signal === "SIGKILL"));
  assert.equal(outcome.delivered, true);
  assert.match(outcome.method, /sigkill|process-group/);
});

test("terminateProcessTree reports delivered false when process is already gone", () => {
  const outcome = terminateProcessTree(999001, {
    platform: "darwin",
    killImpl() {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
});

test("runCommand maps signalled exits to non-zero status", () => {
  const result = runCommand("unused", [], {
    spawnSyncImpl() {
      return {
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        error: null
      };
    },
    sanitizeEnv: false
  });

  assert.equal(result.status, 1);
  assert.equal(result.signal, "SIGTERM");
});

test("runCommand preserves explicit zero status without a signal", () => {
  const result = runCommand("unused", [], {
    spawnSyncImpl() {
      return {
        status: 0,
        signal: null,
        stdout: "ok\n",
        stderr: "",
        error: null
      };
    },
    sanitizeEnv: false
  });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});
