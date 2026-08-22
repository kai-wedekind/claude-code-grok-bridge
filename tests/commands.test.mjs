// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("command set is complete and does not expose continue", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "check.md",
    "critique.md",
    "delegate.md",
    "review.md",
    "runs.md",
    "show.md",
    "stop.md"
  ]);
});

test("plugin surfaces use /grok-build names and grok binary, not codex", () => {
  const files = [
    "commands/check.md",
    "commands/review.md",
    "commands/critique.md",
    "commands/delegate.md",
    "commands/runs.md",
    "commands/show.md",
    "commands/stop.md",
    "agents/grok-delegate.md",
    "hooks/hooks.json",
    "skills/grok-delegate-runtime/SKILL.md",
    "skills/grok-run-output/SKILL.md",
    "scripts/grok-bridge.mjs"
  ];

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /\bcodex\b/i, `${file} should not mention codex`);
    assert.doesNotMatch(source, /codex-companion/, `${file} should not reference codex-companion`);
  }

  const bridge = read("scripts/grok-bridge.mjs");
  assert.match(bridge, /grok-bridge/);
  assert.match(bridge, /GROK_BINARY|resolveGrokBinary|getGrokAvailability/);
  assert.doesNotMatch(bridge, /enable-review-gate|stopReviewGate|stop-review-gate/);

  const review = read("commands/review.md");
  assert.match(review, /\/grok-build:review/);
  assert.match(review, /grok-bridge\.mjs" review/);
  assert.match(review, /AskUserQuestion/);
  assert.match(review, /run_in_background:\s*true/);
  assert.match(review, /review --background/);
  assert.match(review, /Prefer the bridge's own detached worker/i);
  assert.match(review, /Bridge `--background` owns the long-running process group/i);
  assert.doesNotMatch(review, /is what actually detaches the run/);
  assert.match(review, /Do not fix issues/i);
  assert.match(review, /return Grok's output verbatim to the user/i);
  assert.match(review, /The bridge script parses `--wait` and `--background`/);
  assert.match(review, /\(Recommended\)/);
  assert.match(review, /--model <model>/);
  assert.match(review, /--effort <low\|medium\|high\|xhigh>/);

  const critique = read("commands/critique.md");
  assert.match(critique, /\/grok-build:critique/);
  assert.match(critique, /critique --background/);
  assert.match(critique, /uses the same review target selection as `\/grok-build:review`/i);
  assert.match(critique, /can still take extra focus text after the flags/i);
  assert.match(critique, /--model <model>/);
  assert.match(critique, /--effort <low\|medium\|high\|xhigh>/);

  const delegate = read("commands/delegate.md");
  assert.match(delegate, /subagent_type: "grok-build:grok-delegate"/);
  assert.match(delegate, /do not call `Skill\(grok-build:grok-delegate\)`/i);
  assert.doesNotMatch(delegate, /^context:\s*fork\b/m);
  assert.match(delegate, /run-resume-candidate --json/);
  assert.match(delegate, /Continue current Grok thread/);
  assert.match(delegate, /Start a new Grok thread/);

  const agent = read("agents/grok-delegate.md");
  assert.match(agent, /grok-bridge\.mjs" run/);
  assert.match(agent, /--resume-last/);
  assert.match(agent, /thin forwarding wrapper/i);

  const hooks = read("hooks/hooks.json");
  assert.match(hooks, /SessionStart/);
  assert.match(hooks, /SessionEnd/);
  assert.doesNotMatch(hooks, /stop-review-gate-hook\.mjs/);
  assert.doesNotMatch(hooks, /"Stop"/);
  assert.match(hooks, /session-lifecycle-hook\.mjs/);

  const check = read("commands/check.md");
  assert.match(check, /grok-bridge\.mjs" check --json/);
  assert.doesNotMatch(check, /enable-review-gate|disable-review-gate/);

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /### `\/grok-build:check`/);
  assert.match(readme, /### `\/grok-build:review`/);
  assert.match(readme, /### `\/grok-build:critique`/);
  assert.match(readme, /### `\/grok-build:delegate`/);
  assert.match(readme, /### `\/grok-build:runs`/);
  // `import` was removed in 0.3.3 and its absence is asserted, not merely unmentioned. The
  // Grok CLI has had no `import` subcommand since 0.2.118 — the real argv exits 2 with
  // "unexpected argument" — and there is no successor: `sessions` offers list, search and
  // delete, while `--resume` resumes Grok's own sessions rather than ingesting a Claude
  // transcript. Dropping the assertion instead of inverting it would let the command creep
  // back into the docs without the code, which is the drift this file exists to catch.
  //
  // ⚠ THE SLASH FORM WAS NOT ENOUGH, and an audit found it on 2026-08-08. This asserted only
  // that `/grok-build:import` was absent — while the README's CLI reference still carried a
  // bare `import   [--source <claude-jsonl>] …` line, `printUsage()` still taught it, and
  // ADOPTION.md and the routing skill both still counted "eight slash commands" over seven
  // command files. Every one of those passed this test. A user reading the help would run a
  // subcommand the dispatch switch rejects.
  //
  // So the check is now on the CLI form too, and on every surface that documents commands
  // rather than on the README alone.
  const surfaces = [
    ["README.md", readme],
    ["docs/ADOPTION.md", fs.readFileSync(path.join(ROOT, "docs", "ADOPTION.md"), "utf8")],
    ["skills/grok-routing/SKILL.md", read("skills/grok-routing/SKILL.md")],
    ["scripts/grok-bridge.mjs", read("scripts/grok-bridge.mjs")]
  ];
  for (const [label, text] of surfaces) {
    assert.doesNotMatch(text, /grok-build:import/, `${label} must not advertise the removed slash command`);
    assert.doesNotMatch(
      text,
      /^\s*(?:"\s*node scripts\/grok-bridge\.mjs\s+)?import\s+\[/m,
      `${label} must not advertise the removed CLI subcommand either`
    );
  }
  // Seven command files, so nothing may claim eight. Derived from disk rather than written
  // down, because a literal here is the same kind of copy that produced the drift above.
  const commandCount = fs.readdirSync(path.join(PLUGIN_ROOT, "commands"))
    .filter((name) => name.endsWith(".md")).length;
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  // ⚠ BOTH SPELLINGS, AND THE BARE NOUN TOO. This checked only the word form followed by
  // "slash commands", so the README could say — and did, for two releases — "should report
  // 8 commands": the digit form with the bare noun, while the true count had been seven since
  // the import command went in 0eed7ce. The guard existed, ran green, and was looking slightly
  // to the left of the claim. It also stopped at the FIRST match per surface, so a second
  // wrong claim in the same file was unreachable. Found by a docs-versus-code audit 2026-08-09.
  const claimPattern = /\b(zero|one|two|three|four|five|six|seven|eight|nine|\d+)\s+(?:slash\s+)?commands\b/gi;
  for (const [label, text] of surfaces) {
    for (const claim of text.matchAll(claimPattern)) {
      const raw = claim[1].toLowerCase();
      const claimed = /^\d+$/.test(raw) ? Number(raw) : WORDS.indexOf(raw);
      assert.equal(
        claimed,
        commandCount,
        `${label} says "${claim[0].trim()}" but ${commandCount} command files exist`
      );
    }
  }
  assert.match(readme, /### `\/grok-build:show`/);
  assert.match(readme, /### `\/grok-build:stop`/);
  // Derived, not written down. A literal id here would have to be edited in lockstep with
  // marketplace.json, and the failure mode of forgetting is a README that hands the reader
  // an install command for a marketplace that no longer exists. Asking the manifest turns
  // this into a consistency check, which is the thing actually worth guarding.
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8")
  );
  assert.ok(marketplace.name, "marketplace.json must name the marketplace");
  assert.ok(
    readme.includes(`plugin install grok-build@${marketplace.name}`),
    `README must document the install command for marketplace "${marketplace.name}"`
  );
  assert.doesNotMatch(
    readme,
    /plugin install grok-build@xai-grok-build/,
    "the upstream id must not survive anywhere in the install instructions"
  );
  assert.doesNotMatch(readme, /\bcodex\b/i);
  assert.doesNotMatch(readme, /review-gate|enable-review-gate/i);
});

test("runtime skill only forwards run once", () => {
  const runtimeSkill = read("skills/grok-delegate-runtime/SKILL.md");
  assert.match(runtimeSkill, /grok-bridge\.mjs" run "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `run` for every delegate request/i);
  assert.match(runtimeSkill, /run --resume-last/i);
  assert.match(runtimeSkill, /Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop`/);
  assert.match(runtimeSkill, /natural-language task text/);

  const resultHandling = read("skills/grok-run-output/SKILL.md");
  assert.match(resultHandling, /do not turn a failed or incomplete Grok run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Grok was never successfully invoked, do not generate a substitute answer at all/i);
});
