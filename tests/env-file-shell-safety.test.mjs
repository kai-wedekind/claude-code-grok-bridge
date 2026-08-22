/**
 * CLAUDE_ENV_FILE is EVALUATED by the host, so what we write into it runs.
 *
 * The file carries each variable twice — a bare `KEY=value` for plain-text readers and a
 * quoted `export KEY='value'` for the shell. R14b fixed the ORDER so the quoted line wins,
 * which made the exported value correct and left the real problem in place: bash executes
 * the bare line first, and a value that is not a single shell word takes effect there before
 * the export line repairs it.
 *
 * Measured 2026-08-09 by sourcing exactly what `appendEnvVar` writes:
 *
 *   CLAUDE_PLUGIN_DATA=C:\Users\John Smith\.claude\plugins\data
 *     -> "Smith.claudepluginsdata: command not found" on the stderr of EVERY Bash call
 *   CLAUDE_SESSION_ID=abc; echo INJECTED-COMMAND-RAN
 *     -> INJECTED-COMMAND-RAN actually ran
 *
 * A space in the user's name reaches the first one, which is ordinary on Windows. These
 * tests run a real bash against the real bytes rather than asserting on the string, because
 * the question is what a shell DOES with them, not what they look like.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";

const HOOK = path.resolve("plugins/grok-build/scripts/session-lifecycle-hook.mjs");

// ⚠ A `writeEnvVar` helper stood here until 2026-08-17, above a docstring claiming it drove
// "the hook's own writer, so the test cannot drift from the shipped format". It did neither.
// Nothing called it, and the child it spawned only IMPORTED the hook — `name` and `value`
// were never used and the writer was never invoked. Two independent audits flagged it, both
// noting that it still read as this file's official driver, which is the actual hazard: the
// next person extends a convincing helper rather than checking it. The tests below drive the
// writer through a temp `drive.mjs` that really does call it.

// ⚠ EXIT STATUS ALONE DOES NOT ESTABLISH THAT A SHELL IS THERE. On Windows, bare `bash`
// commonly resolves to C:\...\WindowsApps\bash.exe — the WSL app-execution alias — which,
// with no distribution installed, exits 0 and produces nothing at all. The old probe asked
// only for `status === 0`, so it declared bash available, both tests below then asserted
// against an empty string, and the suite reported a shell-injection failure that had never
// happened. Measured 2026-08-09 on one commit: green when `bash` was MSYS2's /usr/bin/bash,
// two false reds when PATH put the WSL alias first. That is a false RED of exactly the shape
// this project keeps finding as a false GREEN — a probe whose silence it cannot interpret.
// So make the shell prove itself: ask it to say something specific, and check that it did.
// It is not enough to ask whether the shell RUNS, either. Under PowerShell on this machine
// `bash` is WSL's, which runs commands perfectly well but cannot resolve `C:/Users/...` —
// that path is `/mnt/c/...` inside it. `source` then reads nothing, every variable comes back
// empty, and the assertions below report an injection failure caused entirely by the path
// namespace. So the probe must exercise the SAME mechanism the tests rely on: write a file at
// a real temp path, source it, and require the value to come back. An availability probe is
// the one place where sharing a dependency with the test is correct rather than a trap — it
// is measuring exactly the capability about to be used.
function probeShell() {
  const dir = makeTempDir();
  const probeFile = path.join(dir, "probe-env");
  fs.writeFileSync(probeFile, "export SHELL_PROBE='canary-42'\n", "utf8");
  const posix = probeFile.replace(/\\/g, "/");
  const run = spawnSync("bash", ["-c", `source '${posix}'; printf '[%s]' "$SHELL_PROBE"`], {
    encoding: "utf8"
  });
  return !run.error && run.status === 0 && (run.stdout || "").includes("[canary-42]");
}
const bashAvailable = probeShell();

test("a value containing a space does not put a stray command into every shell", { skip: !bashAvailable && "bash unavailable" }, () => {
  const dir = makeTempDir();
  const envFile = path.join(dir, "env");
  // Write through the hook's real code path via its module, using a spaced path exactly as a
  // user called "John Smith" would produce.
  const script = path.join(dir, "drive.mjs");
  fs.writeFileSync(
    script,
    `import { appendEnvVar } from ${JSON.stringify(`file:///${HOOK.replace(/\\/g, "/")}`)};\n` +
      `appendEnvVar("CLAUDE_PLUGIN_DATA", String.raw\`C:\\Users\\John Smith\\.claude\\plugins\\data\`);\n`,
    "utf8"
  );
  const driven = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_ENV_FILE: envFile }
  });
  assert.equal(driven.status, 0, `driver failed: ${driven.stderr}`);

  const written = fs.readFileSync(envFile, "utf8");
  assert.match(written, /^export CLAUDE_PLUGIN_DATA='C:\\Users\\John Smith\\/m, "the shell must still get the value");

  const sourced = spawnSync("bash", ["-c", `source '${envFile.replace(/\\/g, "/")}'; echo "V=[$CLAUDE_PLUGIN_DATA]"`], {
    encoding: "utf8"
  });
  assert.doesNotMatch(
    sourced.stderr || "",
    /command not found/,
    "sourcing must not execute part of the value as a command"
  );
  assert.match(sourced.stdout, /V=\[C:\\Users\\John Smith\\\.claude\\plugins\\data\]/);
});

test("a value carrying a shell separator cannot execute", { skip: !bashAvailable && "bash unavailable" }, () => {
  const dir = makeTempDir();
  const envFile = path.join(dir, "env");
  const script = path.join(dir, "drive.mjs");
  fs.writeFileSync(
    script,
    `import { appendEnvVar } from ${JSON.stringify(`file:///${HOOK.replace(/\\/g, "/")}`)};\n` +
      `appendEnvVar("CLAUDE_SESSION_ID", "abc; echo INJECTED-COMMAND-RAN");\n`,
    "utf8"
  );
  const driven = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_ENV_FILE: envFile }
  });
  assert.equal(driven.status, 0, `driver failed: ${driven.stderr}`);

  const sourced = spawnSync("bash", ["-c", `source '${envFile.replace(/\\/g, "/")}'; echo "V=[$CLAUDE_SESSION_ID]"`], {
    encoding: "utf8"
  });
  // ⚠ Match on LINES, not on the substring. The value itself contains the marker, so a
  // substring check would be satisfied by the echo of the variable and would flag the safe
  // case as a failure — the first draft of this test asserted the marker both absent and
  // present, which is unsatisfiable. Only an executed command puts the marker on a line of
  // its own; carried as data it appears only inside `V=[...]`.
  const lines = sourced.stdout.split(/\r?\n/).map((l) => l.trim());
  assert.ok(
    !lines.includes("INJECTED-COMMAND-RAN"),
    `the value must never be executed; stdout was ${JSON.stringify(sourced.stdout)}`
  );
  assert.ok(
    lines.some((l) => l === "V=[abc; echo INJECTED-COMMAND-RAN]"),
    "and must survive intact as data"
  );
});

test("an ordinary value still gets both lines, so the plain-text reader keeps working", { skip: !bashAvailable && "bash unavailable" }, () => {
  const dir = makeTempDir();
  const envFile = path.join(dir, "env");
  const script = path.join(dir, "drive.mjs");
  fs.writeFileSync(
    script,
    `import { appendEnvVar } from ${JSON.stringify(`file:///${HOOK.replace(/\\/g, "/")}`)};\n` +
      `appendEnvVar("CLAUDE_PLUGIN_DATA", String.raw\`C:\\Users\\someone\\.claude\\plugins\\data\`);\n`,
    "utf8"
  );
  spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CLAUDE_ENV_FILE: envFile } });

  const written = fs.readFileSync(envFile, "utf8");
  const lines = written.trim().split("\n");
  assert.equal(lines.length, 2, "the common case must be unchanged: bare line then export line");
  assert.equal(lines[0], String.raw`CLAUDE_PLUGIN_DATA=C:\Users\someone\.claude\plugins\data`);
  assert.match(lines[1], /^export CLAUDE_PLUGIN_DATA='/);
});
