/**
 * Guards of the read-only barrier that the code had and no test held.
 *
 * Each test pins one guard on a real path — a word in the task text, a background run, a
 * subdirectory --cwd, a probe child — so that removing the guard fails here instead of passing
 * the rest of the suite silently. Two more such guards are pinned beside the tests they belong
 * to:
 * the record's `write` in tests/worker-trusts-argv.test.mjs, and review's `--sandbox` in
 * tests/barrier-on-every-launch.test.mjs (which also pins the `--no-plan` review still passes;
 * that flag is not part of the barrier).
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { READ_ONLY_DISALLOWED_TOOLS } from "../plugins/grok-build/scripts/grok-bridge.mjs";
import { runCommand } from "../plugins/grok-build/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function agentLaunches(argvLog) {
  if (!fs.existsSync(argvLog)) return [];
  return fs
    .readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((argv) => argv.includes("-p") || argv.includes("--prompt-file"));
}

function assertReadOnly(argv, label) {
  const joined = argv.join(" ");
  assert.ok(!argv.includes("--always-approve"), `${label}: a read-only launch must not auto-approve — ${joined}`);
  const idx = argv.indexOf("--disallowed-tools");
  assert.ok(idx !== -1, `${label}: --disallowed-tools missing — ${joined}`);
  const removed = argv[idx + 1].split(",");
  for (const tool of READ_ONLY_DISALLOWED_TOOLS) {
    assert.ok(removed.includes(tool), `${label}: ${tool} not removed — ${joined}`);
  }
}

function setup(scenario = "default") {
  const binDir = makeTempDir();
  installFakeGrok(binDir, scenario);
  const argvLog = path.join(makeTempDir(), "argv.log");
  const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir(), GROK_FAKE_ARGV_LOG: argvLog });
  return { env, argvLog };
}

test("a flag-shaped word inside the task text stays task text and grants nothing", () => {
  // `run explain --write this`: everything after the first positional is the task. If the
  // parser kept reading flags there, a task description could switch on write mode.
  const { env, argvLog } = setup();
  const workspace = makeTempDir();
  const result = run(process.execPath, [SCRIPT, "run", "--cwd", workspace, "explain", "--write", "this"], { env });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const all = agentLaunches(argvLog);
  assert.ok(all.length >= 1, "the run must have launched the CLI");
  all.forEach((argv, i) => assertReadOnly(argv, `launch ${i + 1}`));
  const prompt = all[0][all[0].indexOf("-p") + 1] ?? "";
  assert.match(prompt, /explain --write this/, "the words must reach the agent as task text");
});

test("a read-only background run's worker launches read-only", () => {
  // The worker takes write mode from its own argv, and the parent decides that argv. A parent
  // that passed --write unconditionally would turn every background run into a write run.
  const { env, argvLog } = setup();
  const workspace = makeTempDir();
  const queued = run(process.execPath, [SCRIPT, "run", "--background", "--json", "--cwd", workspace, "hello"], {
    env,
    cwd: workspace
  });
  assert.equal(queued.status, 0, `${queued.stdout}${queued.stderr}`);
  const { jobId } = JSON.parse(queued.stdout);
  assert.ok(jobId, queued.stdout);

  const waited = run(process.execPath, [SCRIPT, "show", jobId, "--wait", "--timeout-ms", "60000", "--json"], {
    env,
    cwd: workspace
  });
  assert.equal(waited.status, 0, `${waited.stdout}${waited.stderr}`);

  const all = agentLaunches(argvLog);
  assert.ok(all.length >= 1, "the background worker must have launched the CLI");
  all.forEach((argv, i) => assertReadOnly(argv, `background launch ${i + 1}`));
});

test("a --cwd below the repository root is where the agent runs, not the root", () => {
  // The bridge resolves the repository root for its own bookkeeping and starts the process
  // there; the agent's working directory is the --cwd it hands the CLI, and that must stay the
  // directory that was asked for, or a run scoped to one package sees all of them.
  const { env, argvLog } = setup();
  const repo = makeTempDir();
  initGitRepo(repo);
  const sub = path.join(repo, "pkg");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "a.txt"), "x\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(process.execPath, [SCRIPT, "run", "--cwd", sub, "where am I"], { env });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const all = agentLaunches(argvLog);
  assert.ok(all.length >= 1, "the run must have launched the CLI");
  for (const argv of all) {
    const idx = argv.indexOf("--cwd");
    assert.ok(idx !== -1, `--cwd missing — ${argv.join(" ")}`);
    assert.equal(fs.realpathSync(argv[idx + 1]), fs.realpathSync(sub));
  }
});

test("runCommand hands its probe children the filtered environment, not the caller's", () => {
  // Probe children (version, models, git) get the same allowlist as the agent. Every other
  // runCommand test passed sanitizeEnv: false or ignored the env it handed to spawnSync.
  const probe = "process.stdout.write(String(process.env.ZZ_UNLISTED_PROBE_SECRET ?? 'absent') + '|' + String(process.env.GROK_KEEP_ME ?? 'missing'))";
  const result = runCommand(process.execPath, ["-e", probe], {
    env: { ...process.env, ZZ_UNLISTED_PROBE_SECRET: "leaked", GROK_KEEP_ME: "kept" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "absent|kept");
});
