/**
 * grok 1.0.52 loads this plugin and runs its SessionStart/SessionEnd inside every
 * bridge-launched session (measured 2026-10-15). The grok child is marked
 * GROK_CC_BRIDGE_CHILD=1. The hook must then exit before it can cancel the Claude
 * session's jobs or write the host env file.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "grok-build", "scripts", "session-lifecycle-hook.mjs");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");
const SESSION_ID = "session-bridge-child";

function seedRunningJob(workspace, pluginDataDir) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const job = {
      id: "job-bridge-child",
      sessionId: SESSION_ID,
      status: "running",
      jobClass: "task",
      title: "still running",
      workspaceRoot: workspace,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(workspace, job.id, job);
    upsertJob(workspace, job);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

function storedStatus(workspace, pluginDataDir) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return readJobFile(resolveJobFile(workspace, "job-bridge-child")).status;
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

function hookEnv(pluginDataDir, extra) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    GROK_CC_UPDATE_CHECK: "0",
    GROK_CC_SESSION_ID: SESSION_ID,
    ...extra
  };
}

test("with the bridge-child marker the hook does not touch jobs or the env file", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const envFile = path.join(pluginDataDir, "claude-env.txt");
  seedRunningJob(workspace, pluginDataDir);

  // No session_id in the payload: without the marker, SessionEnd falls back to
  // GROK_CC_SESSION_ID and cancels every active job of that Claude session.
  const ended = run(process.execPath, [HOOK, "SessionEnd"], {
    cwd: workspace,
    env: hookEnv(pluginDataDir, { GROK_CC_BRIDGE_CHILD: "1", CLAUDE_ENV_FILE: envFile }),
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: workspace }),
    timeout: 15000
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(ended.stdout, "");
  assert.equal(ended.stderr, "");
  assert.equal(storedStatus(workspace, pluginDataDir), "running");
  assert.equal(fs.existsSync(envFile), false);

  const started = run(process.execPath, [HOOK, "SessionStart"], {
    cwd: workspace,
    env: hookEnv(pluginDataDir, { GROK_CC_BRIDGE_CHILD: "1", CLAUDE_ENV_FILE: envFile }),
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      cwd: workspace,
      session_id: SESSION_ID,
      source: "startup"
    }),
    timeout: 15000
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, "");
  assert.equal(started.stderr, "");
  assert.equal(fs.existsSync(envFile), false, "SessionStart must not write the host env file");
  assert.equal(storedStatus(workspace, pluginDataDir), "running");
});

test("without the marker, SessionEnd still cancels that session and SessionStart still writes the env file", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const envFile = path.join(pluginDataDir, "claude-env.txt");
  seedRunningJob(workspace, pluginDataDir);

  const ended = run(process.execPath, [HOOK, "SessionEnd"], {
    cwd: workspace,
    env: hookEnv(pluginDataDir, { CLAUDE_ENV_FILE: envFile }),
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: workspace }),
    timeout: 15000
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(storedStatus(workspace, pluginDataDir), "cancelled");

  const started = run(process.execPath, [HOOK, "SessionStart"], {
    cwd: workspace,
    env: hookEnv(pluginDataDir, { CLAUDE_ENV_FILE: envFile }),
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      cwd: workspace,
      session_id: SESSION_ID,
      source: "startup"
    }),
    timeout: 15000
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(fs.existsSync(envFile), true);
  assert.match(fs.readFileSync(envFile, "utf8"), new RegExp(SESSION_ID));
});

test("a bridge run's grok child receives GROK_CC_BRIDGE_CHILD", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);
  const promptFile = path.join(pluginDataDir, "prompt.txt");
  fs.writeFileSync(promptFile, "hello\n");

  const result = run(process.execPath, [SCRIPT, "run", "--prompt-file", promptFile], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, GROK_FAKE_LOG: fakeGrokLog }),
    timeout: 60000
  });
  assert.equal(result.status, 0, result.stderr);
  const entries = fs
    .readFileSync(fakeGrokLog, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const prompts = entries.filter(
    (entry) => entry.argv.includes("-p") || entry.argv.includes("--prompt-file")
  );
  assert.ok(prompts.length >= 1, "the run must have launched a prompt");
  for (const entry of prompts) {
    assert.equal(entry.bridgeChild, "1");
  }
});

// `check --verify-tools` starts a real model
// session through runGrok, not through the headless spawn above, and went out unmarked.
test("check --verify-tools marks the grok session it starts, and the models probe too", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);

  run(process.execPath, [SCRIPT, "check", "--verify-tools", "--json"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, GROK_FAKE_LOG: fakeGrokLog }),
    timeout: 60000
  });
  const entries = fs
    .readFileSync(fakeGrokLog, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const sessions = entries.filter((entry) => entry.argv.includes("-p"));
  const models = entries.filter((entry) => entry.argv[0] === "models");
  assert.ok(sessions.length >= 1, `verify-tools must have started a session: ${JSON.stringify(entries)}`);
  assert.ok(models.length >= 1, `check must have probed grok models: ${JSON.stringify(entries)}`);
  for (const entry of [...sessions, ...models]) {
    assert.equal(entry.bridgeChild, "1", JSON.stringify(entry.argv));
  }
});
