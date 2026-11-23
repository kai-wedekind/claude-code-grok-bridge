/**
 * Every grok process the bridge starts runs with
 * Grok's memory off (GROK_MEMORY=0), unless the user set GROK_MEMORY, which is then left
 * exactly as it is.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { bridgeChildEnv } from "../plugins/grok-build/scripts/lib/grok.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

/** buildEnv copies process.env, so a GROK_MEMORY in the developer's shell is removed first. */
function envWithoutMemory(binDir, extra) {
  const env = buildEnv(binDir);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "GROK_MEMORY") delete env[key];
  }
  return { ...env, ...extra };
}

function logEntries(logPath) {
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function runPrompt(env, pluginDataDir) {
  const repo = makeTempDir();
  initGitRepo(repo);
  const promptFile = path.join(pluginDataDir, "prompt.txt");
  fs.writeFileSync(promptFile, "hello\n");
  return run(process.execPath, [SCRIPT, "run", "--prompt-file", promptFile], {
    cwd: repo,
    env,
    timeout: 60000
  });
}

test("bridgeChildEnv turns memory off and marks the child when GROK_MEMORY is unset", () => {
  const input = { PATH: "/bin", GROK_FOO: "x" };
  const out = bridgeChildEnv(input, "linux");
  assert.equal(out.GROK_MEMORY, "0");
  assert.equal(out.GROK_CC_BRIDGE_CHILD, "1");
  assert.equal(out.GROK_FOO, "x");
  assert.equal("GROK_MEMORY" in input, false, "the caller's object must not be mutated");
});

test("bridgeChildEnv keeps a GROK_MEMORY the user set, whatever its value", () => {
  assert.equal(bridgeChildEnv({ GROK_MEMORY: "1" }, "linux").GROK_MEMORY, "1");
  assert.equal(bridgeChildEnv({ GROK_MEMORY: "0" }, "win32").GROK_MEMORY, "0");
  assert.equal(bridgeChildEnv({ GROK_MEMORY: "" }, "linux").GROK_MEMORY, "");
});

test("on Windows any casing counts as set and no second spelling is added", () => {
  const out = bridgeChildEnv({ Grok_Memory: "1" }, "win32");
  assert.equal(out.Grok_Memory, "1");
  assert.equal("GROK_MEMORY" in out, false);
});

test("elsewhere a differently cased name is not the variable the CLI reads", () => {
  const out = bridgeChildEnv({ grok_memory: "1" }, "linux");
  assert.equal(out.grok_memory, "1");
  assert.equal(out.GROK_MEMORY, "0");
});

test("a bridge run's grok child runs with GROK_MEMORY=0", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);

  const result = runPrompt(
    envWithoutMemory(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, GROK_FAKE_LOG: fakeGrokLog }),
    pluginDataDir
  );
  assert.equal(result.status, 0, result.stderr);
  const prompts = logEntries(fakeGrokLog).filter(
    (entry) => entry.argv.includes("-p") || entry.argv.includes("--prompt-file")
  );
  assert.ok(prompts.length >= 1, "the run must have launched a prompt");
  for (const entry of prompts) {
    assert.equal(entry.memory, "0", JSON.stringify(entry.argv));
  }
});

test("a GROK_MEMORY set by the user reaches the bridge run's child unchanged", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);

  const result = runPrompt(
    envWithoutMemory(binDir, {
      CLAUDE_PLUGIN_DATA: pluginDataDir,
      GROK_FAKE_LOG: fakeGrokLog,
      GROK_MEMORY: "1"
    }),
    pluginDataDir
  );
  assert.equal(result.status, 0, result.stderr);
  const prompts = logEntries(fakeGrokLog).filter(
    (entry) => entry.argv.includes("-p") || entry.argv.includes("--prompt-file")
  );
  assert.ok(prompts.length >= 1, "the run must have launched a prompt");
  for (const entry of prompts) {
    assert.equal(entry.memory, "1", JSON.stringify(entry.argv));
  }
});

test("check --verify-tools starts its grok session with GROK_MEMORY=0", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);

  run(process.execPath, [SCRIPT, "check", "--verify-tools", "--json"], {
    cwd: repo,
    env: envWithoutMemory(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, GROK_FAKE_LOG: fakeGrokLog }),
    timeout: 60000
  });
  const sessions = logEntries(fakeGrokLog).filter((entry) => entry.argv.includes("-p"));
  assert.ok(sessions.length >= 1, "verify-tools must have started a session");
  for (const entry of sessions) {
    assert.equal(entry.memory, "0", JSON.stringify(entry.argv));
  }
});
