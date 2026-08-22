// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  buildReviewPrompt,
  getGrokAuthStatus,
  getGrokAvailability,
  parseStructuredOutput,
  resolveGrokBinary,
  runHeadlessAgent
} from "../plugins/grok-build/scripts/lib/grok.mjs";
import { runCommand } from "../plugins/grok-build/scripts/lib/process.mjs";

test("resolveGrokBinary prefers GROK_BINARY override", () => {
  assert.equal(resolveGrokBinary({ GROK_BINARY: "/custom/grok" }), "/custom/grok");
  assert.equal(resolveGrokBinary({}), "grok");
});

test("getGrokAvailability reports available with fake grok on PATH", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);

  const status = getGrokAvailability(process.cwd(), { env });
  assert.equal(status.available, true);
  assert.match(status.detail, /0\.2\.83-fake|ok/i);
});

test("getGrokAuthStatus uses models probe success as logged in", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.source, "models-probe");
});

test("getGrokAuthStatus treats failed models as not logged in", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "not-logged-in");
  const env = buildEnv(binDir);

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, false);
  assert.match(auth.detail, /Not logged in|not logged in|failed/i);
});

test("runHeadlessAgent captures stdout and session id from fake grok", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, {
    prompt: "check the thing",
    env,
    permissionMode: "plan",
    sandbox: "read-only"
  });

  assert.equal(result.status, 0);
  assert.match(result.finalMessage, /Handled the requested task/);
  assert.equal(typeof result.threadId, "string");
  assert.ok(result.threadId.length > 0);
  assert.ok(result.args.includes("-p"));
  assert.ok(result.args.includes("--permission-mode"));
  assert.ok(result.args.includes("plan"));
});

test("buildHeadlessArgs applies executeTaskRun read-only and write option objects", async () => {
  // buildHeadlessArgs is not exported; pin the option→argv mapping via returned args.
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const readOnly = await runHeadlessAgent(cwd, {
    prompt: "ro options",
    env,
    alwaysApprove: false,
    noPlan: true,
    sandbox: "read-only",
    disallowedTools: ["run_terminal_cmd", "search_replace"],
    denyRules: ["Bash", "Write", "Edit", "MCPTool"],
    outputFormat: "json",
    globalSlot: false
  });
  assert.ok(readOnly.args.includes("--no-plan"));
  assert.ok(readOnly.args.includes("--sandbox"));
  assert.equal(readOnly.args[readOnly.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(readOnly.args.includes("--disallowed-tools"));
  assert.equal(
    readOnly.args[readOnly.args.indexOf("--disallowed-tools") + 1],
    "run_terminal_cmd,search_replace"
  );
  const denies = [];
  for (let index = 0; index < readOnly.args.length; index += 1) {
    if (readOnly.args[index] === "--deny") {
      denies.push(readOnly.args[index + 1]);
    }
  }
  assert.deepEqual(denies, ["Bash", "Write", "Edit", "MCPTool"]);
  assert.ok(readOnly.args.includes("--output-format"));
  assert.equal(readOnly.args[readOnly.args.indexOf("--output-format") + 1], "json");
  assert.equal(readOnly.args.includes("--always-approve"), false);

  const writeRun = await runHeadlessAgent(cwd, {
    prompt: "write options",
    env,
    alwaysApprove: true,
    noPlan: false,
    outputFormat: "json",
    globalSlot: false
  });
  assert.ok(writeRun.args.includes("--always-approve"));
  assert.equal(writeRun.args.includes("--no-plan"), false);
  assert.equal(writeRun.args.includes("--disallowed-tools"), false);
  assert.equal(writeRun.args.includes("--deny"), false);
  assert.equal(writeRun.args.includes("--sandbox"), false);
});

// The runImport test that stood here was removed with the command in 0.3.3, and it is worth
// recording why it passed for as long as it did: tests/fake-grok-fixture.mjs implements
// `argv[0] === "import"` and hands back a fake session id. So the suite exercised a subcommand
// the real CLI had already dropped in 0.2.118, and reported it working. A fixture that
// implements more than the thing it stands in for does not test a contract, it invents one.

test("parseStructuredOutput extracts fenced JSON", () => {
  const raw = 'Here you go:\n```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```\n';
  const parsed = parseStructuredOutput(raw);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput does not let fallback clobber canonical fields", () => {
  const parsed = parseStructuredOutput('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}', {
    parsed: { verdict: "needs-attention" },
    parseError: "stale",
    rawOutput: "stale",
    status: 7
  });
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.status, 7);
});

test("runHeadlessAgent reports agentPid from the spawned child", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();
  const progressEvents = [];

  const result = await runHeadlessAgent(cwd, {
    prompt: "pid check",
    env,
    onProgress: (event) => progressEvents.push(event)
  });

  assert.equal(typeof result.agentPid, "number");
  assert.ok(result.agentPid > 0);
  assert.ok(progressEvents.some((event) => event?.agentPid === result.agentPid));
});

test("buildReviewPrompt includes target and focus", () => {
  const prompt = buildReviewPrompt({
    targetLabel: "working tree diff",
    focusText: "auth boundaries",
    collectionGuidance: "Use the repository context below as primary evidence.",
    reviewInput: "## Git Status\n M app.js"
  });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /auth boundaries/);
  assert.match(prompt, /Git Status/);
});

test("live grok --help advertises headless flags when grok is on PATH", (t) => {
  const help = runCommand("grok", ["--help"], { cwd: process.cwd() });
  if (help.error?.code === "ENOENT" || help.status !== 0) {
    // ⚠ SAY SO. This used to `return` bare, which node:test records as a plain pass with
    // zero assertions — so on CI, or on any machine without the CLI, a test named for what
    // the live binary advertises reported success having asked it nothing. Three sibling
    // containment tests had the same shape and were converted on 2026-08-16; this one was
    // outside that order's scope and is the fourth.
    //
    // ⚠ Not every early return is this defect. A triage on 2026-08-17 found one where the
    // return IS the success path, and converting it would have introduced a bug. The test
    // here is whether the branch means "the property held" or "I could not look".
    t.skip("no usable `grok` on PATH, so there is no live --help to read; skipping is honest, passing would not be");
    return;
  }
  const text = `${help.stdout}\n${help.stderr}`;
  for (const flag of [
    "-p",
    "--single",
    "-r",
    "--resume",
    "--session-id",
    "--always-approve",
    "--agent",
    "--permission-mode",
    "--sandbox",
    "--output-format",
    "--json-schema",
    "--effort"
  ]) {
    assert.match(text, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
