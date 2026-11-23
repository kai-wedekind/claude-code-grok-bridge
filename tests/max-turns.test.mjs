/**
 * --max-turns exhaustion is an exit-1 envelope plus one stderr line, not the empty
 * exit-0 turn the nudge exists for. cli-1.0.45 headless.rs:1397-1406 and
 * xai-grok-pager-bin main.rs:2120-2128.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { failureHeadline } from "../plugins/grok-build/scripts/lib/render.mjs";
import { listJobs, resolveJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function runScenario(scenario, extraArgs = ["--json"]) {
  const binDir = makeTempDir();
  installFakeGrok(binDir, scenario);
  return run(
    process.execPath,
    [SCRIPT, "run", ...extraArgs, "--cwd", makeTempDir(), "review the auth notes"],
    { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() }) }
  );
}

test("max-turns is its own failure, keeps the partial text, and is not retried as-is", () => {
  const result = runScenario("max-turns");
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 2, "exit 2: the same limit is hit again");
  assert.equal(payload.failureCode, "max-turns");
  assert.equal(payload.delivered, false);
  assert.match(payload.rawOutput, /Partial review so far/);
  assert.match(payload.rawOutput, /grok login/);
  assert.match(payload.rawOutput, /XAI_API_KEY/);
  assert.equal(payload.stopReason, "cancelled");
  assert.equal(failureHeadline("max-turns"), "Grok ran out of turns before finishing; the text so far is below.");

  const rendered = runScenario("max-turns", []);
  assert.match(rendered.stdout, /ran out of turns before finishing/);
  assert.match(rendered.stdout, /Partial review so far/);
  assert.doesNotMatch(rendered.stdout, /Nobody is signed in/);
});

// The progress line written at classification time becomes the job record's lastMessage, which
// is what `runs` and `show` print as "Last:". The tests above
// read the rendered result and the failure code, never that line.
function storedLastMessage(scenario) {
  const binDir = makeTempDir();
  installFakeGrok(binDir, scenario);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  run(process.execPath, [SCRIPT, "run", "--json", "--cwd", workspace, "review the auth notes"], {
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
  });
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1, "the run must have been recorded");
    return JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobs[0].id), "utf8")).lastMessage;
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("a max-turns run says it ran out of turns in its last progress line", () => {
  const lastMessage = storedLastMessage("max-turns");
  assert.match(lastMessage, /ran out of turns before finishing/);
  assert.match(lastMessage, /--max-turns/);
  assert.doesNotMatch(lastMessage, /exited with status/i);
  assert.doesNotMatch(lastMessage, /signed in/i);
});

test("auth phrases inside a non-error envelope do not produce the signed-out progress line", () => {
  const lastMessage = storedLastMessage("envelope-with-auth-hints");
  assert.doesNotMatch(lastMessage, /nobody is signed in/i);
  assert.doesNotMatch(lastMessage, /grok login/i);
});

test("auth phrases inside a non-error envelope are not an authentication failure", () => {
  const result = runScenario("envelope-with-auth-hints");
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.failureCode, "cli-error");
  assert.equal(result.status, 1);
  assert.match(payload.rawOutput, /grok login/);
  assert.match(payload.rawOutput, /The module looks fine/);
});
