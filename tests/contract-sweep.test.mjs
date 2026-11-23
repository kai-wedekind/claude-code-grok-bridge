/**
 * The contract and honesty findings from a six-pass review. Small fixes, each of which was
 * invisible precisely because nothing asserted it.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  describeStateRootOrigin,
  listNamedThreads,
  listWorkspaceStateDirs,
  resolveStateDir
} from "../plugins/grok-build/scripts/lib/state.mjs";
import { collectUsage } from "../plugins/grok-build/scripts/lib/usage-ledger.mjs";
import { renderJobStatusReport } from "../plugins/grok-build/scripts/lib/render.mjs";
import {
  describeConfinement,
  interpretToolIdProbe,
  READ_ONLY_DENY_RULES,
  READ_ONLY_DISALLOWED_TOOLS,
  TOOL_ID_PROBE_CONTROL
} from "../plugins/grok-build/scripts/grok-bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function withPluginData(pluginDataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("the turn count is visible without opening the JSON", () => {
  // A run that emitted its opening narration and stopped looks, in the listing, exactly
  // like one that answered: same status, same phase, plausible duration. The turn count
  // is the only mechanical difference, it was already on the record, and it was reachable
  // only through the raw payload — useless for the person scanning `runs` output.
  const finished = renderJobStatusReport({
    id: "run-abc",
    status: "completed",
    phase: "done",
    title: "Grok Build Delegate",
    result: { numTurns: 1 }
  });
  assert.match(finished, /Turns: 1/);

  // Nothing invented where the CLI reported nothing: a queued run has no turn count, and
  // an envelope that never arrived must not become a zero.
  const queued = renderJobStatusReport({
    id: "run-def",
    status: "queued",
    phase: "queued",
    title: "Grok Build Delegate"
  });
  assert.doesNotMatch(queued, /Turns:/);
});

test("a run recorded outside the shared state root says so", () => {
  // The fallback root is deliberate — the bridge has to work without the variable — but a
  // run kept there is invisible to `runs`, to the ledger, and to the SessionEnd cleanup
  // that stops background agents. Two waiters polled the wrong root for forty minutes on
  // 2026-07-31 before anyone noticed, because nothing said a word.
  const shared = describeStateRootOrigin({ CLAUDE_PLUGIN_DATA: "C:\\data" });
  assert.equal(shared.source, "plugin-data");
  assert.equal(shared.disclosure, null, "nothing to disclose when the shared root is used");

  const fallback = describeStateRootOrigin({});
  assert.equal(fallback.source, "fallback");
  assert.match(fallback.disclosure, /CLAUDE_PLUGIN_DATA is not set/);
  assert.match(
    fallback.disclosure,
    /SessionEnd cleanup/,
    "the consequence that matters is the one about agents outliving their session"
  );
  assert.ok(fallback.root.length > 0);
});

test("a barrier that does not hold on this platform says so", () => {
  // The flag is on the command line either way, so nothing in a successful run revealed
  // that the kernel layer had quietly not applied. Reporting a degraded state instead of
  // running on silently is the one habit worth taking from the courier-style bridges.
  const windows = describeConfinement(false, "win32");
  assert.equal(windows.kernelSandbox, "requested-not-enforced");
  assert.deepEqual(windows.layers, ["disallowed-tools", "deny-rules"]);
  assert.match(windows.disclosure, /not enforced on this platform/);

  // ⚠ THIS TEST USED TO PIN THE OVERCLAIM. It asserted that `linux` alone yields `enforced`
  // with nothing to disclose, so the suite actively defended the belief that a platform NAME
  // implies a kernel mechanism — while SECURITY.md and the acceptance gate said otherwise.
  // Landlock is a kernel config option and Raspberry Pi OS ships without it (measured
  // 2026-08-09). Only a positive confirmation earns `enforced`; the other two states are
  // distinct, and both disclose. Found by a docs-versus-code audit that read the runtime as
  // well as the prose.
  // macOS gets no free pass either. Seatbelt exists by construction, but nothing probes it and
  // this project has no Mac — "the mechanism exists" is not "the CLI applied it". Two reviews
  // reached this independently on 2026-08-09, after an earlier fix had added a disclosure and
  // left the enum saying `enforced`, so the field a consumer branches on still overstated it.
  const darwin = describeConfinement(false, "darwin");
  assert.equal(darwin.kernelSandbox, "unverified", "no probe runs on darwin, so nothing is confirmed");
  assert.ok(!darwin.layers.includes("sandbox"), "an unprobed layer is not a layer");
  assert.match(darwin.disclosure, /unverified on macOS/);

  const landlockPresent = describeConfinement(false, "linux", () => "present");
  assert.equal(landlockPresent.kernelSandbox, "enforced");
  assert.ok(landlockPresent.layers.includes("sandbox"));
  assert.equal(landlockPresent.disclosure, null, "nothing to disclose when every layer holds");

  // Current CLIs refuse to start `read-only` when Landlock is absent, so the bridge does not
  // ask for it, and `not-requested` records exactly that.
  const landlockAbsent = describeConfinement(false, "linux", () => "absent");
  assert.equal(landlockAbsent.kernelSandbox, "not-requested");
  assert.deepEqual(landlockAbsent.layers, ["disallowed-tools", "deny-rules"]);
  assert.match(landlockAbsent.disclosure, /Landlock is not among the active LSMs/);
  assert.match(landlockAbsent.disclosure, /refuse to start/);
  assert.match(landlockAbsent.disclosure, /--sandbox off/);
  assert.match(landlockAbsent.disclosure, /grok 1\.0\.70/);
  assert.match(landlockAbsent.disclosure, /Tool removal and deny rules are the whole barrier/);

  // "Could not tell" is its own state. Collapsing it into either neighbour is the defect this
  // release keeps finding, so it is asserted as distinct from both.
  const landlockUnknown = describeConfinement(false, "linux", () => "unknown");
  assert.equal(landlockUnknown.kernelSandbox, "unverified");
  assert.ok(!landlockUnknown.layers.includes("sandbox"));
  assert.match(landlockUnknown.disclosure, /unverified on this kernel/);
  assert.notEqual(
    landlockUnknown.disclosure,
    landlockAbsent.disclosure,
    "absent and unknown must not read alike"
  );

  // Write mode has no barrier at all, which is easy to forget precisely because the
  // read-only path has three. It says so rather than staying quiet.
  const write = describeConfinement(true, "linux");
  assert.deepEqual(write.layers, []);
  assert.match(write.disclosure, /no confinement is enforced/);
});

test("every run says what confined it — including review and critique", (t) => {
  // ⚠ THE TITLE USED TO OVERSTATE WHAT THIS COVERED. It said "every run" and exercised only
  // `run`, while `describeConfinement` had exactly one call site — so `review` and `critique`
  // launched under the identical read-only regime and disclosed nothing about it. A user
  // reviewing a repository they do not trust is precisely who needs to know which layers hold,
  // and theirs was the command that never said. Found by an architectural review 2026-08-09;
  // the test name had promised the coverage for weeks.
  // The absence-detectability lesson, from the same project: a security assurance you
  // only emit when something is wrong cannot be distinguished from one that got dropped.
  // On Linux there is nothing to disclose and the warning is legitimately absent — so the
  // thing that must always be present is the descriptor, not the warning.
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir);

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--cwd", repo, "--json", "name one colour"],
    { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir }) }
  );

  const payload = JSON.parse(result.stdout);
  assert.ok(payload.confinement, "every run payload carries the confinement descriptor");

  // And the same for review, which shares the barrier and used to share none of the honesty.
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "reviewable.txt"), "a line worth reviewing\n", "utf8");
  const reviewResult = run(
    process.execPath,
    [SCRIPT, "review", "--cwd", repo, "--json"],
    { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir }) }
  );
  const reviewPayload = JSON.parse(reviewResult.stdout);
  assert.ok(reviewPayload.confinement, "a review payload carries the confinement descriptor too");

  // ⚠ AND CRITIQUE, WHICH THIS TITLE HAS NAMED SINCE 2026-08-09 WITHOUT EVER LAUNCHING IT.
  // Found by a backlog triage 2026-08-17 and ranked second of everything still open. Not a
  // hypothetical gap: critique is a separate branch — `handleReviewCommand(argv, { reviewName:
  // "Critique" })` — and `executeReviewRun` already switches on that name, so a one-line
  // `if (reviewName !== "Critique")` around the descriptor would have stayed green under a
  // test whose own title promised otherwise. A title is quotable in release notes; this one
  // now costs a launch to keep.
  const critiqueResult = run(
    process.execPath,
    [SCRIPT, "critique", "--cwd", repo, "--json"],
    { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir }) }
  );
  const critiquePayload = JSON.parse(critiqueResult.stdout);
  assert.ok(
    critiquePayload.confinement,
    "a critique payload carries the confinement descriptor too — it shares the barrier, so it must share the disclosure"
  );
  assert.equal(
    critiquePayload.confinement.kernelSandbox,
    payload.confinement.kernelSandbox,
    "critique runs under the same regime, so it must report the same state"
  );
  assert.equal(critiquePayload.confinement.mode, "read-only");
  assert.equal(
    reviewPayload.confinement.kernelSandbox,
    payload.confinement.kernelSandbox,
    "review runs under the same regime, so it must report the same state"
  );
  assert.equal(payload.confinement.mode, "read-only");
  assert.ok(
    Array.isArray(payload.confinement.layers) && payload.confinement.layers.length > 0,
    "and it names at least one barrier that actually holds"
  );
  assert.ok(payload.confinement.layers.includes("disallowed-tools"));
  assert.ok(payload.confinement.layers.includes("deny-rules"));

  // Where a requested layer does not hold, the caller is told without having to inspect
  // the descriptor at all.
  if (payload.confinement.kernelSandbox === "requested-not-enforced") {
    assert.ok(
      payload.warnings.some((entry) => /Sandbox not enforced/.test(entry)),
      "a degraded barrier has to reach warnings, not only the descriptor"
    );
  }
  // Linux without Landlock. The sandbox was not asked for; the warning has to say so.
  if (payload.confinement.kernelSandbox === "not-requested") {
    assert.equal(payload.confinement.mode, "read-only");
    assert.ok(
      payload.warnings.some((entry) => /--sandbox off/.test(entry)),
      "passing off has to reach warnings, not only the descriptor"
    );
  }
});

test("read-only removes the MCP meta-tools as well as the write tools", () => {
  // Two entry points reach an MCP server that may itself write: search_tool and use_tool.
  // The deny rule rejects the MCPTool class at call time, but a barrier that rests on one
  // rule engine parsing one pattern correctly is a barrier with a single point of failure.
  // Removing the tools outright is the second, independent layer — the pairing comes from
  // tylersue/claude-grok-delegation, whose read-only mode does the same.
  //
  // Asserted against the real constants rather than a copy: a test that restates the list
  // it is checking cannot notice the list changing (which is how grok-cli.test.mjs, which
  // passes its own literal array, would have missed this).
  // ⚠ EXACT MEMBERSHIP, NOT A SUBSET. This used to check that four named ids were present,
  // which is green for any list that contains those four — so when the list grew to thirteen,
  // the nine additions were unenforced from the moment they landed. Deleting them all would
  // have left CI passing while the barrier they describe was gone. That is the same shape as
  // asserting a flag can appear rather than that it does: true, and about the wrong thing.
  //
  // Both directions are asserted deliberately. A MISSING id means a barrier was removed. An
  // UNEXPECTED id means one was added without being verified against the installed CLI — and
  // an id the CLI does not know is silently inert, reading as protection while removing
  // nothing. Two of the ids an internal roadmap prescribed (`delete_file`, `edit_notebook`)
  // turned out not to exist at all.
  //
  // So changing this list is meant to cost a moment's thought: update the snapshot AND re-run
  // the verification. That is a throwaway run with `--disallowed-tools <candidates>
  // --debug-file <path>`, then grep the log for `disallowedTools entry matched nothing`,
  // always with a deliberate fake among the candidates as a control — without one you cannot
  // tell a clean result from a broken probe.
  const EXPECTED_DISALLOWED = [
    "run_terminal_cmd",     // the shell
    "search_replace",       // the file editor
    "search_tool",          // MCP meta-tool
    "use_tool",             // MCP meta-tool
    "write",                // observed being called on a read-only run
    "monitor",              // advertised to the model, offers a shell path
    "image_gen",            // the media tools all put files on disk
    "image_edit",
    "image_to_video",
    "reference_to_video",
    "web_fetch",            // retrieves whatever a URL serves; web_search stays, see below
    "scheduler_create",     // durable state that outlives the run
    "scheduler_delete",
    "scheduler_list"        // not for protection — the requirement graph, see the test below
  ];
  assert.deepEqual(
    [...READ_ONLY_DISALLOWED_TOOLS].sort(),
    [...EXPECTED_DISALLOWED].sort(),
    "read-only tool removal changed: re-verify every id against the installed CLI before updating this snapshot"
  );

  assert.ok(
    !READ_ONLY_DISALLOWED_TOOLS.includes("web_search"),
    "web search stays: read-only carries research offloads, where looking things up is the task"
  );
  assert.deepEqual(READ_ONLY_DENY_RULES, ["Bash", "Write", "Edit", "MCPTool"]);
});

test("the scheduler ids are removed as a set or not at all", () => {
  // The CLI's tools declare requirements on each other. Removing `scheduler_create` while
  // `scheduler_list` survives makes the session fail to INITIALISE — `run` does not degrade,
  // it dies, with an internal RequirementError naming the dependent. Measured 2026-08-08
  // against grok 1.0.0; the shipped list carried exactly that combination and every read-only
  // run on the tree was dead until this test existed.
  //
  // It is an invariant and not a snapshot on purpose: the snapshot above already pins today's
  // membership, and would have to be edited by the same hand that breaks this. This one states
  // the rule, so a future edit that adds or drops one scheduler id meets it here.
  const TRIO = ["scheduler_create", "scheduler_delete", "scheduler_list"];
  const present = READ_ONLY_DISALLOWED_TOOLS.filter((id) => id.startsWith("scheduler_"));
  if (present.length === 0) return;
  assert.deepEqual(
    [...present].sort(),
    [...TRIO].sort(),
    "removing a scheduler tool without its dependents breaks session init — take all three or none"
  );
});

// The snapshot above catches US changing the list. It cannot catch xAI renaming a tool
// underneath us — the snapshot still matches, this test still passes, and the barrier quietly
// loses a tool. `check --verify-tools` closes that by asking the binary; these four cover the
// judgement it makes about the answer, which is the half that can be wrong without a CLI.
const probeLine = (id) => `2026-08-08T12:00:00Z WARN  disallowedTools entry matched nothing tool=${id}`;
// Taken from the constant rather than frozen. These tests used a hardcoded 13 while the list
// held 14 — harmless, because `total` is only echoed back, but it advertised a number the
// product does not use and nothing would have noticed the two diverging further.
const TOTAL = READ_ONLY_DISALLOWED_TOOLS.length;

test("the tool-id probe names exactly the ids the CLI did not recognise", () => {
  const log = [
    "2026-08-08T12:00:00Z INFO  starting session",
    probeLine("delete_file"),
    probeLine(TOOL_ID_PROBE_CONTROL),
    "2026-08-08T12:00:01Z INFO  done"
  ].join("\n");
  const verdict = interpretToolIdProbe(log, TOTAL);
  assert.equal(verdict.checked, true);
  assert.deepEqual(verdict.unmatched, ["delete_file"], "the control must never be reported as a finding of ours");
  assert.equal(verdict.total, TOTAL);
});

test("a clean probe reports nothing unmatched, and still proves it could have", () => {
  const verdict = interpretToolIdProbe(probeLine(TOOL_ID_PROBE_CONTROL), TOTAL);
  assert.deepEqual(verdict, { checked: true, total: TOTAL, unmatched: [] });
});

test("two ids on one log line are both reported, not just the first", () => {
  // The parser ran one non-greedy exec per line, so the FIRST tool= won. With the control
  // first, the gate passed and the real id vanished — `checked: true, unmatched: []`, a false
  // all-clear. Today's CLI writes one id per line, so this was a contract hole rather than a
  // live failure; it is pinned because "the format currently suits us" is nobody's commitment.
  const log =
    "WARN  disallowedTools entry matched nothing tool=" +
    TOOL_ID_PROBE_CONTROL +
    " also tool=delete_file";
  const verdict = interpretToolIdProbe(log, TOTAL);
  assert.equal(verdict.checked, true);
  assert.deepEqual(verdict.unmatched, ["delete_file"], "the id after the control must not be dropped");
});

test("check --verify-tools does not exit 0 when it could not tell", () => {
  // The flag reported honestly in text and exited 0 regardless, so every consumer without eyes
  // — CI, a shell `&&`, a release script — read a broken or unverifiable barrier as success.
  // That is the exact false green the release is about, in the command whose whole job is
  // telling you the truth about your setup.
  //
  // The fake grok writes no --debug-file, so the probe cannot read a verdict: the honest answer
  // is "I do not know", and the honest exit code is not 0. (2 for unknown, 1 for a real finding
  // — different problems, different responses.)
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const result = run(
    process.execPath,
    [SCRIPT, "check", "--verify-tools", "--json", "--cwd", makeTempDir()],
    { env: { ...buildEnv(binDir), CLAUDE_PLUGIN_DATA: makeTempDir() } }
  );
  assert.equal(result.status, 2, "an unreadable probe must not report success");
  const report = JSON.parse(result.stdout);
  assert.equal(report.toolIds.checked, false);
  assert.deepEqual(report.toolIds.unmatched, []);
  assert.ok(report.toolIds.error, "and it must say why it could not tell");
});

test("a tool= outside the warning line is not mistaken for a finding", () => {
  // The guard added with the multi-match fix: only lines carrying the warning phrase are read.
  // Without it, any debug line mentioning tool= would become a reported id.
  const log = ["INFO  invoking tool=web_search", probeLine(TOOL_ID_PROBE_CONTROL)].join("\n");
  assert.deepEqual(interpretToolIdProbe(log, TOTAL).unmatched, []);
});

test("a probe that cannot see its own control answers UNKNOWN, never all-clear", () => {
  // This is the whole reason the control exists. Every one of these logs would read as a
  // perfect result without it — and the last two are what xAI shipping a reworded log line
  // or a renamed flag actually looks like from here.
  for (const [label, log] of [
    ["empty file", ""],
    ["the run never got that far", "2026-08-08T12:00:00Z INFO  starting session"],
    ["wording moved", "WARN  unknown tool in disallowed list: " + TOOL_ID_PROBE_CONTROL],
    ["our ids reported but not the control", probeLine("web_fetch")]
  ]) {
    const verdict = interpretToolIdProbe(log, 13);
    assert.equal(verdict.checked, false, `${label}: a blind probe must not report success`);
    assert.deepEqual(verdict.unmatched, [], `${label}: an unreadable log yields no findings either`);
    assert.match(verdict.error, /control id/, `${label}: say why it is unknown`);
  }
});

test("the same id logged twice is one finding", () => {
  const log = [probeLine("web_fetch"), probeLine("web_fetch"), probeLine(TOOL_ID_PROBE_CONTROL)].join("\n");
  assert.deepEqual(interpretToolIdProbe(log, 13).unmatched, ["web_fetch"]);
});

test("the schema size cap applies to the batch path too", () => {
  // README and both skills promised one flat limit. It lived only in the single-run path,
  // so a batch caller sailed past it and failed deep inside spawn() with ENAMETOOLONG
  // instead of getting the message written for exactly this case.
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir);

  const promptsFile = path.join(repo, "prompts.txt");
  fs.writeFileSync(promptsFile, "one prompt\n", "utf8");

  const huge = JSON.stringify({
    type: "object",
    description: "x".repeat(20000)
  });
  assert.ok(huge.length > 16000, "the fixture has to exceed the cap to test it");

  const result = run(
    process.execPath,
    [SCRIPT, "run", "--prompts-file", promptsFile, "--json-schema", huge, "--cwd", repo],
    { env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir }) }
  );

  assert.notEqual(result.status, 0, "an oversized schema must not reach the CLI");
  assert.match(`${result.stderr}${result.stdout}`, /--json-schema is too large/);
});

test("the allowance period is reported separately from the rolling window", () => {
  // Both are seven days and they are offset against each other, so the rolling figure is
  // the wrong number for a budget decision. Measured 2026-07-31: the rolling window ran
  // 28 % above the allowance period — against one target, that is the difference between
  // "nearly spent" and "a third still free". Surfaced while wiring an availability switch
  // on top of this figure.
  const stateRoot = makeTempDir();
  const jobs = path.join(stateRoot, "ws-0000000000000000", "jobs");
  fs.mkdirSync(jobs, { recursive: true });

  const nowMs = Date.now();
  const hoursAgo = (h) => new Date(nowMs - h * 3600 * 1000).toISOString();
  const write = (id, stamp, cost) =>
    fs.writeFileSync(
      path.join(jobs, `${id}.json`),
      JSON.stringify({ id, status: "completed", updatedAt: stamp, costUsd: cost }),
      "utf8"
    );

  write("run-inside", hoursAgo(12), 3); // inside both
  write("run-before-period", hoursAgo(120), 5); // inside the rolling window, before the period

  // A period that began 48 hours ago, expressed the way the cache expresses it: as an end.
  const periodEnd = new Date(nowMs + 5 * 24 * 3600 * 1000).toISOString();
  const report = collectUsage({
    stateRoot,
    includeTestWorkspaces: true,
    subscriptionOverride: { percentUsed: 1, periodEnd, observedAt: hoursAgo(1) }
  });

  assert.equal(report.costUsd, 8, "the rolling window still reports everything it covers");
  assert.ok(report.period, "and the period is reported alongside it");
  assert.equal(report.period.costUsd, 3, "the period excludes what predates it");
  assert.equal(report.period.runs, 1);
});

test("a workspace with no jobs directory does not take the whole report down", () => {
  // The budget report walks every workspace under the state root, and not all of them
  // have run anything yet — the test suite alone leaves such directories behind. When the
  // no-jobs path returned a bare array while the rest of the function returned an object,
  // that destructured to undefined and the report died on "records is not iterable".
  // Every workspace in ordinary use had a jobs directory, so it first showed up under
  // --include-test-workspaces, which pulls the empty ones in.
  const stateRoot = makeTempDir();
  fs.mkdirSync(path.join(stateRoot, "leer-0000000000000000"), { recursive: true });
  const withJobs = path.join(stateRoot, "voll-0000000000000000", "jobs");
  fs.mkdirSync(withJobs, { recursive: true });
  fs.writeFileSync(
    path.join(withJobs, "run-ok.json"),
    JSON.stringify({ id: "run-ok", status: "completed", updatedAt: new Date().toISOString(), costUsd: 2 }),
    "utf8"
  );

  const report = collectUsage({ stateRoot, includeTestWorkspaces: true });
  assert.equal(report.runs, 1, "the populated workspace still counts");
  assert.equal(report.costUsd, 2);
  assert.equal(report.damagedRecords, 0, "an empty workspace is not a damaged record");
});

test("a job file that will not parse is reported, not counted as zero", () => {
  // The ledger swallowed unreadable records in an empty catch, which books the run at
  // exactly zero — the same silent understatement that usageIncomplete exists to prevent,
  // arrived at through a truncated write rather than a killed process.
  const stateRoot = makeTempDir();
  const workspace = path.join(stateRoot, "some-workspace-0000000000000000");
  fs.mkdirSync(path.join(workspace, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "jobs", "run-broken.json"), "{ this is not json", "utf8");
  fs.writeFileSync(
    path.join(workspace, "jobs", "run-fine.json"),
    JSON.stringify({
      id: "run-fine",
      status: "completed",
      updatedAt: new Date().toISOString(),
      costUsd: 1.25
    }),
    "utf8"
  );

  const report = collectUsage({ stateRoot, includeTestWorkspaces: true });
  assert.equal(report.runs, 1, "the readable run still counts");
  assert.equal(report.damagedRecords, 1, "and the unreadable one is not silently dropped");
});

test("a corrupt thread registry is surfaced by the listing, not rendered as empty", () => {
  // getNamedThread was strict and listNamedThreads was not, so `threads` said "you have
  // none" while resuming any of them threw. The listing is where a person looks to find
  // out what is wrong; it was the one place that hid it.
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();

  withPluginData(pluginDataDir, () => {
    const stateDir = resolveStateDir(repo);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "named-threads.json"), "{ broken", "utf8");

    assert.throws(() => listNamedThreads(repo));
  });
});

test("a workspace whose index is gone is still found by its job files", () => {
  // Requiring state.json made a workspace invisible to every cross-workspace consumer in
  // the one case where that matters: the index was corrupt, its repair failed, and the
  // job records were sitting on disk with nothing left that would look at them.
  const pluginDataDir = makeTempDir();

  withPluginData(pluginDataDir, () => {
    const orphaned = path.join(pluginDataDir, "state", "lost-workspace-0000000000000000");
    fs.mkdirSync(path.join(orphaned, "jobs"), { recursive: true });
    fs.writeFileSync(
      path.join(orphaned, "jobs", "run-stranded.json"),
      JSON.stringify({ id: "run-stranded", status: "running" }),
      "utf8"
    );

    const dirs = listWorkspaceStateDirs();
    assert.ok(
      dirs.some((dir) => path.basename(dir) === "lost-workspace-0000000000000000"),
      "SessionEnd, relocation and the ledger all walk this list"
    );
  });
});
