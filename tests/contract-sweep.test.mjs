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
import { makeTempDir, run } from "./helpers.mjs";
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
  READ_ONLY_DENY_RULES,
  READ_ONLY_DISALLOWED_TOOLS
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

  const posix = describeConfinement(false, "linux");
  assert.equal(posix.kernelSandbox, "enforced");
  assert.ok(posix.layers.includes("sandbox"));
  assert.equal(posix.disclosure, null, "nothing to disclose when every layer holds");

  // Write mode has no barrier at all, which is easy to forget precisely because the
  // read-only path has three. It says so rather than staying quiet.
  const write = describeConfinement(true, "linux");
  assert.deepEqual(write.layers, []);
  assert.match(write.disclosure, /no confinement is enforced/);
});

test("every run says what confined it, so a missing disclosure is itself detectable", () => {
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
  for (const tool of ["run_terminal_cmd", "search_replace", "search_tool", "use_tool"]) {
    assert.ok(
      READ_ONLY_DISALLOWED_TOOLS.includes(tool),
      `${tool} must not be available to a read-only run`
    );
  }
  assert.ok(
    !READ_ONLY_DISALLOWED_TOOLS.includes("web_search"),
    "web search stays: read-only carries research offloads, where looking things up is the task"
  );
  assert.deepEqual(READ_ONLY_DENY_RULES, ["Bash", "Write", "Edit", "MCPTool"]);
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
