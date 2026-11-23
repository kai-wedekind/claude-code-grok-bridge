/**
 * A read-only run never hands the CLI a prompt that starts with "/": the CLI may take such a
 * prompt as one of its own slash commands rather than as a task.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function launch(args) {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const argvLog = path.join(makeTempDir(), "argv.log");
  const result = run(process.execPath, [SCRIPT, "run", "--json", "--cwd", makeTempDir(), ...args], {
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir(), GROK_FAKE_ARGV_LOG: argvLog })
  });
  const launches = fs.existsSync(argvLog)
    ? fs.readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const first = launches[0] ?? [];
  const sent = first.includes("-p") ? first[first.indexOf("-p") + 1] : null;
  return { result, payload: JSON.parse(result.stdout), sent };
}

test("a read-only prompt that starts with a slash reaches the CLI behind a note line", () => {
  // Any leading Unicode white space counts before the "/".
  for (const prompt of ["/some-command", "  /some-command with arguments", "\u0085/some-command", "　/some-command"]) {
    const { result, payload, sent } = launch([prompt]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(typeof sent === "string", `no -p prompt in argv for ${JSON.stringify(prompt)}`);
    assert.doesNotMatch(sent, /^\p{White_Space}*\//u, `the CLI would dispatch ${JSON.stringify(sent)}`);
    assert.ok(sent.includes(prompt.trim()), "the caller's text is still sent, after the note");
    assert.ok(payload.warnings.some((w) => /began with "\/"/.test(w)), JSON.stringify(payload.warnings));
  }
});

test("a prompt file that starts with a slash is guarded the same way", () => {
  const file = path.join(makeTempDir(), "task.md");
  fs.writeFileSync(file, "\n\n/some-command\n", "utf8");
  const { payload, sent } = launch(["--prompt-file", file]);
  assert.ok(typeof sent === "string", "a short prompt file travels as -p text");
  assert.doesNotMatch(sent, /^\p{White_Space}*\//u);
  assert.ok(payload.warnings.some((w) => /began with "\/"/.test(w)), JSON.stringify(payload.warnings));
});

test("a prompt that does not start with a slash is sent unchanged and carries no slash warning", () => {
  const { payload, sent } = launch(["check /etc/hosts for the entry"]);
  assert.equal(sent, "check /etc/hosts for the entry");
  assert.equal(payload.warnings.some((w) => /began with "\/"/.test(w)), false);
});

test("a write run is not rewritten: write mode is unconfined by design", () => {
  const { sent } = launch(["--write", "/some-command the topic"]);
  assert.equal(sent, "/some-command the topic");
});
