/**
 * `run --connector <name>[,<name>…]` lets a run use the Grok-side connectors (Google Calendar,
 * Notion, …) that the user signed in to, without the credential ever reaching this plugin.
 *
 * What these tests pin, because each was a measured failure or a deliberate choice:
 *
 * - The opening is exactly two tools and one deny rule, derived from the read-only lists, so a
 *   tool added to read-only later is removed here too.
 * - Each named connector is one allow rule, and the run is pinned to `--permission-mode
 *   default`. Measured 2026-09-23 against grok 1.0.41: without the pin the CLI took
 *   `always-approve` from ~/.grok/config.toml and a call outside the allow rule went through;
 *   with it, the same call was cancelled.
 * - The child gets GROK_MANAGED_MCPS_ENABLED / GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED, without
 *   which a headless process never fetches the connector catalog.
 * - Never an automatic retry: a connector can create or delete, so a nudge after a partial run
 *   could repeat the action, exactly as for --write.
 * - Foreground only, and a background worker never runs it — an edited job record must not be
 *   able to open connectors the parent never asked for.
 * - Read-only runs are unchanged by all of this.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";
import {
  CONNECTOR_CHILD_ENV,
  CONNECTOR_DENY_RULES,
  CONNECTOR_DISALLOWED_TOOLS,
  READ_ONLY_DENY_RULES,
  READ_ONLY_DISALLOWED_TOOLS,
  describeConnectorConfinement,
  parseConnectorList
} from "../plugins/grok-build/scripts/grok-bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

// Lines in the CLI's chat_history.jsonl format, as recorded by grok 1.0.41.
const HISTORY_CATALOG_NEVER_LOADED = [
  { type: "assistant", tool_calls: [{ id: "c1", name: "use_tool", arguments: "{}" }] },
  {
    type: "tool_result",
    tool_call_id: "c1",
    content:
      "Tool `google_calendar__search` failed via `use_tool`: Tool not found: google_calendar__search"
  },
  { type: "assistant", tool_calls: [{ id: "c2", name: "search_tool", arguments: "{}" }] },
  {
    type: "tool_result",
    tool_call_id: "c2",
    content: JSON.stringify({
      results: [],
      total_hidden_tools: 0,
      status: "ready",
      note: "No MCP tools are available in this session."
    })
  }
];
const HISTORY_CATALOG_LOADED = [
  { type: "assistant", tool_calls: [{ id: "c1", name: "search_tool", arguments: "{}" }] },
  {
    type: "tool_result",
    tool_call_id: "c1",
    content: JSON.stringify({
      results: [{ server: "google_calendar", tools: [{ tool_name: "google_calendar__search" }] }],
      total_hidden_tools: 178,
      status: "ready"
    })
  }
];
// A connector run whose only call was one the allow rules refused. The catalog is not shown
// missing — it is simply not shown at all.
const HISTORY_ONLY_REFUSED = [
  { type: "assistant", tool_calls: [{ id: "c1", name: "use_tool", arguments: "{}" }] },
  { type: "tool_result", tool_call_id: "c1", content: "User cancelled the execution for tool `use_tool`" }
];

function writeHistory(history) {
  const file = path.join(makeTempDir(), "chat_history.jsonl");
  fs.writeFileSync(file, history.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

function setup(scenario = "default", history = null, stopReason = null) {
  const binDir = makeTempDir();
  installFakeGrok(binDir, scenario);
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  const fakeGrokLog = path.join(makeTempDir(), "fake-grok.log");
  // A private GROK_HOME, so the bridge's session-history check never reads the real ~/.grok.
  const grokHome = makeTempDir();
  let historyFile;
  if (history) {
    historyFile = path.join(makeTempDir(), "chat_history.jsonl");
    fs.writeFileSync(historyFile, history.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  // The ambient switches are cleared so a pass proves the bridge set them, not the test runner.
  const env = buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    GROK_FAKE_LOG: fakeGrokLog,
    GROK_HOME: grokHome,
    GROK_FAKE_HISTORY_FILE: historyFile,
    GROK_FAKE_STOP_REASON: stopReason ?? undefined,
    GROK_MANAGED_MCPS_ENABLED: undefined,
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: undefined
  });
  return { env, workspace, pluginDataDir, fakeGrokLog };
}

// Every invocation of the fake grok, probes included (`version`, `models`).
function allInvocations(fakeGrokLog) {
  if (!fs.existsSync(fakeGrokLog)) {
    return [];
  }
  return fs
    .readFileSync(fakeGrokLog, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Only the prompt-bearing agent launches.
function agentLaunches(fakeGrokLog) {
  return allInvocations(fakeGrokLog).filter(
    (entry) => entry.argv.includes("-p") || entry.argv.includes("--prompt-file")
  );
}

function flagValues(argv, flag) {
  const values = [];
  argv.forEach((token, i) => {
    if (token === flag) {
      values.push(argv[i + 1]);
    }
  });
  return values;
}

function bridge(env, workspace, args) {
  return run(process.execPath, [SCRIPT, "run", "--json", "--cwd", workspace, ...args], { env });
}

test("the connector lists are the read-only lists minus exactly the two meta-tools and MCPTool", () => {
  assert.deepEqual(
    READ_ONLY_DISALLOWED_TOOLS.filter((id) => !CONNECTOR_DISALLOWED_TOOLS.includes(id)).sort(),
    ["search_tool", "use_tool"]
  );
  assert.ok(
    CONNECTOR_DISALLOWED_TOOLS.every((id) => READ_ONLY_DISALLOWED_TOOLS.includes(id)),
    "connector mode must never remove a tool read-only keeps"
  );
  assert.deepEqual(
    READ_ONLY_DENY_RULES.filter((rule) => !CONNECTOR_DENY_RULES.includes(rule)),
    ["MCPTool"]
  );
  assert.ok(CONNECTOR_DENY_RULES.every((rule) => READ_ONLY_DENY_RULES.includes(rule)));
  assert.deepEqual(CONNECTOR_CHILD_ENV, {
    GROK_MANAGED_MCPS_ENABLED: "true",
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "true"
  });
});

test("connector names: one or a comma-separated list, de-duplicated, never a wildcard", () => {
  assert.deepEqual(parseConnectorList("google_calendar"), ["google_calendar"]);
  assert.deepEqual(parseConnectorList(" google_calendar , notion,google_calendar "), [
    "google_calendar",
    "notion"
  ]);
  assert.deepEqual(parseConnectorList("my-connector"), ["my-connector"]);
  assert.deepEqual(parseConnectorList(undefined), []);
  // Exact tools, so a read task can be limited mechanically to read tools.
  assert.deepEqual(parseConnectorList("google_calendar__search,notion__notion-search"), [
    "google_calendar__search",
    "notion__notion-search"
  ]);
  for (const bad of [
    "*",
    "google_calendar__*",
    "google_calendar__",
    "__search",
    "a__b__c",
    "google_calendar___search",
    "Gmail",
    "a b",
    "google_calendar,",
    "",
    "_x",
    "x-",
    "a(b)"
  ]) {
    assert.throws(() => parseConnectorList(bad), /--connector/, `must refuse "${bad}"`);
  }
});

test("the confinement record names the mode, the connectors and the allow rules", () => {
  const record = describeConnectorConfinement(["google_calendar", "notion"], "linux", () => "absent");
  assert.equal(record.mode, "connector");
  assert.deepEqual(record.connectors, ["google_calendar", "notion"]);
  assert.deepEqual(record.allowRules, ["MCPTool(google_calendar__*)", "MCPTool(notion__*)"]);
  assert.match(record.disclosure, /--permission-mode default/);
  assert.match(record.disclosure, /create, send, change or delete/);
  // The gate is additive; the record must say which of the user's own settings widen it.
  assert.match(record.disclosure, /Always allow/);
  assert.match(record.disclosure, /defaultMode of auto/);
  assert.match(record.disclosure, /local MCP server/);
  // The platform disclosure from read-only is kept, not replaced.
  assert.match(record.disclosure, /Landlock/);
});

test("an exact tool becomes an exact allow rule, and the note says only that tool may be called", () => {
  const { env, workspace, fakeGrokLog } = setup();
  const result = bridge(env, workspace, [
    "--connector",
    "google_calendar__search,google_calendar__get_event,notion",
    "what is on tuesday"
  ]);

  assert.equal(result.status, 0, result.stderr);
  const [{ argv }] = agentLaunches(fakeGrokLog);
  assert.deepEqual(flagValues(argv, "--allow"), [
    "MCPTool(google_calendar__search)",
    "MCPTool(google_calendar__get_event)",
    "MCPTool(notion__*)"
  ]);
  assert.match(flagValues(argv, "-p")[0], /only that tool of the connector may be called/);
});

test("a resumed thread is graded on this run's history only, not on an earlier turn's", () => {
  // The CLI appends a resumed session to the same history file, so one good search in turn 1
  // must not vouch for a turn 2 whose catalog never loaded.
  const { env, workspace } = setup("default", HISTORY_CATALOG_LOADED);
  const first = bridge(env, workspace, ["--connector", "google_calendar", "--thread", "cal", "turn one"]);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(JSON.parse(first.stdout).threadRegistered, true);

  const secondEnv = { ...env, GROK_FAKE_HISTORY_FILE: writeHistory(HISTORY_CATALOG_NEVER_LOADED) };
  const second = bridge(secondEnv, workspace, ["--connector", "google_calendar", "--thread", "cal", "turn two"]);
  assert.equal(second.status, 2, second.stdout);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.failureCode, "connector-unavailable");
  assert.deepEqual(payload.connectorCheck, { verdict: "never-loaded", searchCalls: 1, useCalls: 1, refusedCalls: 0, reason: null });
});

function userLine(text) {
  return { type: "user", content: [{ type: "text", text }] };
}

test("a prune that shrinks the prefix still grades this run", () => {
  // Retained pruning replaces an aged tool result with the short placeholder and
  // rewrites the file, so a byte offset taken before the run lands inside this run. The
  // positive search is in the first part of this run; padding keeps the file longer than
  // the mark. The verdict has to stay loaded.
  const prior = [
    userLine("old turn"),
    { type: "assistant", tool_calls: [{ id: "old1", name: "use_tool", arguments: "{}" }] },
    { type: "tool_result", tool_call_id: "old1", content: "x".repeat(20000) },
    userLine("recent turn"),
    { type: "assistant", tool_calls: [{ id: "r1", name: "read_file", arguments: "{}" }] },
    { type: "tool_result", tool_call_id: "r1", content: "ok" }
  ];
  const { env, workspace } = setup("default", prior);
  const first = bridge(env, workspace, ["--connector", "google_calendar", "--thread", "cal", "turn one"]);
  assert.equal(first.status, 0, first.stdout);

  const thisRun = [
    { type: "assistant", tool_calls: [{ id: "s", name: "search_tool", arguments: "{}" }] },
    {
      type: "tool_result",
      tool_call_id: "s",
      content: JSON.stringify({ results: [{ tool_name: "google_calendar__search" }], total_hidden_tools: 1 })
    },
    { type: "assistant", content: "y".repeat(25000) }
  ];
  const secondEnv = {
    ...env,
    GROK_FAKE_HISTORY_FILE: writeHistory(thisRun),
    GROK_FAKE_HISTORY_REWRITE: "1"
  };
  const second = bridge(secondEnv, workspace, ["--connector", "google_calendar", "--thread", "cal", "turn two"]);
  assert.equal(second.status, 0, second.stdout);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.failureCode, null);
  assert.equal(payload.connectorCheck.verdict, "loaded");
  assert.equal(payload.connectorCheck.reason, null);
});

test("a prune that grows the prefix does not let an earlier success grade this run", () => {
  // Swapping tiny "{}" results for the longer placeholder grows the prefix, which
  // pulls an unpruned later success back across a byte offset. This run's own catalog
  // never loaded, and that is the verdict the check has to return.
  const tinies = [];
  for (let i = 0; i < 80; i++) {
    tinies.push({ type: "assistant", tool_calls: [{ id: `t${i}`, name: "use_tool", arguments: "{}" }] });
    tinies.push({ type: "tool_result", tool_call_id: `t${i}`, content: "{}" });
  }
  const prior = [
    userLine("old turn"),
    ...tinies,
    userLine("recent turn"),
    { type: "assistant", tool_calls: [{ id: "s", name: "search_tool", arguments: "{}" }] },
    {
      type: "tool_result",
      tool_call_id: "s",
      content: JSON.stringify({ results: [{ tool_name: "google_calendar__list" }], total_hidden_tools: 3 })
    }
  ];
  const { env, workspace } = setup("default", prior);
  const first = bridge(env, workspace, ["--connector", "google_calendar", "--thread", "cal", "turn one"]);
  assert.equal(first.status, 0, first.stdout);

  const thisRun = [
    { type: "assistant", tool_calls: [{ id: "e", name: "search_tool", arguments: "{}" }] },
    {
      type: "tool_result",
      tool_call_id: "e",
      content: JSON.stringify({ results: [], total_hidden_tools: 0, status: "ready" })
    },
    { type: "assistant", tool_calls: [{ id: "u", name: "use_tool", arguments: "{}" }] },
    {
      type: "tool_result",
      tool_call_id: "u",
      content: "Tool `google_calendar__search` failed via `use_tool`: Tool not found: google_calendar__search"
    }
  ];
  const secondEnv = {
    ...env,
    GROK_FAKE_HISTORY_FILE: writeHistory(thisRun),
    GROK_FAKE_HISTORY_REWRITE: "1"
  };
  const second = bridge(secondEnv, workspace, ["--connector", "google_calendar", "--thread", "cal", "turn two"]);
  assert.equal(second.status, 2, second.stdout);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.failureCode, "connector-unavailable");
  assert.equal(payload.connectorCheck.verdict, "never-loaded");
});

test("a run whose marker is not in the history is inconclusive", () => {
  const { env, workspace } = setup("default", HISTORY_CATALOG_NEVER_LOADED);
  const result = bridge({ ...env, GROK_FAKE_HISTORY_OMIT_PROMPT: "1" }, workspace, [
    "--connector",
    "google_calendar",
    "what is on tuesday"
  ]);

  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, null);
  assert.equal(payload.connectorCheck.verdict, "inconclusive");
  assert.equal(payload.connectorCheck.reason, "marker-missing");
  assert.equal(payload.connectorCheck.searchCalls, 0);
  assert.ok(payload.warnings.some((w) => /marker was not found/.test(w)), payload.warnings.join("\n"));
});

test("a refusal that ended the run wins over an empty first search", () => {
  // The prompt note makes the model poll, so an empty first search is the normal race; a
  // refused call after it must still be reported as refused, never as "safe to re-run".
  const history = [
    { type: "assistant", tool_calls: [{ id: "s1", name: "search_tool", arguments: "{}" }] },
    { type: "tool_result", tool_call_id: "s1", content: JSON.stringify({ results: [], total_hidden_tools: 0, status: "ready" }) },
    ...HISTORY_ONLY_REFUSED
  ];
  const { env, workspace } = setup("default", history, "cancelled");
  const result = bridge(env, workspace, ["--connector", "google_calendar__search", "create an event"]);

  assert.equal(result.status, 2, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "connector-refused");
  assert.doesNotMatch(payload.failureMessage, /safe/);
});

test("a never-loaded run that spawned a subagent is inconclusive, never 'safe to re-run'", () => {
  const { env, workspace } = setup("default", HISTORY_CATALOG_NEVER_LOADED);
  const result = bridge({ ...env, GROK_FAKE_SPAWN_SUBAGENT: "1" }, workspace, [
    "--connector",
    "google_calendar",
    "look it up"
  ]);

  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, null);
  assert.equal(payload.connectorCheck.verdict, "inconclusive");
  assert.equal(payload.connectorCheck.reason, "subagents");
  assert.ok(payload.warnings.some((w) => /spawned subagents/.test(w)));
});

test("an earlier turn's subagent does not hide a catalog that never loaded", () => {
  // The directory is created during this run, so its mtime is now, but started_at
  // is an earlier turn. Only started_at may count.
  const { env, workspace } = setup("default", HISTORY_CATALOG_NEVER_LOADED);
  const result = bridge(
    {
      ...env,
      GROK_FAKE_SPAWN_SUBAGENT: "1",
      GROK_FAKE_SUBAGENT_STARTED_AT: "2020-01-01T00:00:00.000Z"
    },
    workspace,
    ["--connector", "google_calendar", "look it up"]
  );

  assert.equal(result.status, 2, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "connector-unavailable");
  assert.equal(payload.connectorCheck.verdict, "never-loaded");
  assert.equal(payload.connectorCheck.reason, null);
});

test("no connector call in the parent says the children's calls are not checked", () => {
  const history = [
    { type: "assistant", tool_calls: [{ id: "a", name: "read_file", arguments: "{}" }] },
    { type: "tool_result", tool_call_id: "a", content: "file text" }
  ];
  const { env, workspace } = setup("default", history);
  const result = bridge({ ...env, GROK_FAKE_SPAWN_SUBAGENT: "1" }, workspace, [
    "--connector",
    "google_calendar",
    "look it up"
  ]);

  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.connectorCheck.verdict, "no-connector-calls");
  assert.equal(payload.connectorCheck.reason, "subagents");
  const warnings = payload.warnings.join("\n");
  assert.match(warnings, /parent made no search_tool or use_tool call/);
  assert.match(warnings, /not checked/);
  assert.doesNotMatch(warnings, /nothing in the reply comes from a connector/);
});

test("a connector run that ended cancelled with no refusal on record says so", () => {
  const { env, workspace } = setup("default", HISTORY_CATALOG_LOADED, "cancelled");
  const result = bridge(env, workspace, ["--connector", "google_calendar", "look it up"]);

  assert.equal(result.status, 0, result.stdout);
  const warnings = JSON.parse(result.stdout).warnings.join("\n");
  assert.match(warnings, /ended cancelled/);
  assert.match(warnings, /does not show one/);
  assert.doesNotMatch(warnings, /was not checked/);
});

test("a cancelled run whose history was not read does not claim there was no refusal", () => {
  // --max-turns exhaustion is stopReason cancelled and exit 1 (cli-1.0.45
  // turn.rs:1712-1713, headless.rs:1403-1406). The history check does not run.
  const { env, workspace } = setup("default", HISTORY_CATALOG_LOADED, "cancelled");
  const result = bridge({ ...env, GROK_FAKE_EXIT_STATUS: "1" }, workspace, [
    "--connector",
    "google_calendar",
    "--max-turns",
    "2",
    "look it up"
  ]);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stopReason, "cancelled");
  assert.equal(payload.connectorCheck, null);
  const warnings = payload.warnings.join("\n");
  assert.match(warnings, /ended cancelled/);
  assert.match(warnings, /was not checked/);
  assert.doesNotMatch(warnings, /does not show one/);
  assert.doesNotMatch(warnings, /refused call ends a run/);
});

test("an unreadable history on a cancelled run is not also 'does not show one'", () => {
  const { env, workspace } = setup("default", null, "cancelled");
  const result = bridge(env, workspace, ["--connector", "google_calendar", "look it up"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.connectorCheck.verdict, "unreadable");
  assert.equal(payload.connectorCheck.reason, "unreadable");
  const warnings = payload.warnings.join("\n");
  assert.match(warnings, /Could not read/);
  assert.match(warnings, /was not checked/);
  assert.doesNotMatch(warnings, /does not show one/);
});

test("a policy denial on a run that continued is a warning, not connector-refused", () => {
  // PolicyDeny writes this text and the turn continues (cli-1.0.45 tool_calls.rs:1926, :1945).
  const history = [
    ...HISTORY_CATALOG_LOADED,
    { type: "assistant", tool_calls: [{ id: "c9", name: "use_tool", arguments: "{}" }] },
    {
      type: "tool_result",
      tool_call_id: "c9",
      content: "Tool `use_tool` was not executed: Auto mode blocked this action."
    }
  ];
  const { env, workspace } = setup("default", history);
  const result = bridge(env, workspace, ["--connector", "google_calendar__search", "create an event"]);

  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, null);
  assert.equal(payload.connectorCheck.verdict, "loaded");
  assert.equal(payload.connectorCheck.refusedCalls, 1);
  assert.ok(
    payload.warnings.some((w) => /1 connector call\(s\) were refused, and the run continued/.test(w)),
    payload.warnings.join("\n")
  );
});

test("a reject that ended the run is connector-refused", () => {
  // Reject is "{reason} for tool `use_tool`" and the turn ends cancelled (tool_calls.rs:1928).
  const history = [
    { type: "assistant", tool_calls: [{ id: "c1", name: "use_tool", arguments: "{}" }] },
    {
      type: "tool_result",
      tool_call_id: "c1",
      content: "User previously rejected `google_calendar__create_event` in this project for tool `use_tool`"
    }
  ];
  const { env, workspace } = setup("default", history, "cancelled");
  const result = bridge(env, workspace, ["--connector", "google_calendar__search", "create an event"]);

  assert.equal(result.status, 2, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "connector-refused");
  assert.equal(payload.connectorCheck.verdict, "inconclusive");
  assert.equal(payload.connectorCheck.reason, "no-sign");
  assert.equal(payload.connectorCheck.refusedCalls, 1);
});

test("a repeated --connector keeps only the last value, as documented", () => {
  const { env, workspace, fakeGrokLog } = setup();
  const result = bridge(env, workspace, ["--connector", "google_calendar", "--connector", "notion", "look"]);

  assert.equal(result.status, 0, result.stderr);
  const [{ argv }] = agentLaunches(fakeGrokLog);
  assert.deepEqual(flagValues(argv, "--allow"), ["MCPTool(notion__*)"]);
});

test("a connector run whose catalog never loaded fails as connector-unavailable, not as success", () => {
  const { env, workspace } = setup("default", HISTORY_CATALOG_NEVER_LOADED);
  const result = bridge(env, workspace, ["--connector", "google_calendar", "what is on tuesday"]);

  assert.equal(result.status, 2, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "connector-unavailable");
  assert.equal(payload.delivered, false);
  assert.deepEqual(payload.connectorCheck, { verdict: "never-loaded", searchCalls: 1, useCalls: 1, refusedCalls: 0, reason: null });
  assert.match(payload.failureMessage, /never loaded/);
  assert.match(payload.failureMessage, /safe/);
});

test("a connector run whose catalog loaded is reported as checked and delivered", () => {
  const { env, workspace } = setup("default", HISTORY_CATALOG_LOADED);
  const result = bridge(env, workspace, ["--connector", "google_calendar", "what is on tuesday"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, null);
  assert.deepEqual(payload.connectorCheck, { verdict: "loaded", searchCalls: 1, useCalls: 0, refusedCalls: 0, reason: null });
});

test("a refusal that ended the run is connector-refused, never connector-unavailable", () => {
  const { env, workspace } = setup("default", HISTORY_ONLY_REFUSED, "cancelled");
  const result = bridge(env, workspace, ["--connector", "google_calendar__search", "create an event"]);

  assert.equal(result.status, 2, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "connector-refused");
  assert.deepEqual(payload.connectorCheck, {
    verdict: "inconclusive",
    searchCalls: 0,
    useCalls: 1,
    refusedCalls: 1,
    reason: "no-sign"
  });
  assert.match(payload.failureMessage, /refused/);
  assert.match(payload.failureMessage, /same refusal/, "it must not advise a re-run that cannot help");
  assert.doesNotMatch(payload.failureMessage, /never loaded/);
});

test("a refusal the run survived is a warning, not a failure", () => {
  const history = [
    ...HISTORY_CATALOG_LOADED,
    { type: "assistant", tool_calls: [{ id: "c9", name: "use_tool", arguments: "{}" }] },
    { type: "tool_result", tool_call_id: "c9", content: "User cancelled the execution for tool `use_tool`" }
  ];
  const { env, workspace } = setup("default", history);
  const result = bridge(env, workspace, ["--connector", "google_calendar__search", "look it up"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, null);
  assert.equal(payload.connectorCheck.verdict, "loaded");
  assert.equal(payload.connectorCheck.refusedCalls, 1);
  assert.ok(payload.warnings.some((w) => /1 connector call\(s\) were refused, and the run continued/.test(w)));
});

test("a connector run whose history cannot be found is delivered with a warning, not failed", () => {
  const { env, workspace } = setup();
  const result = bridge(env, workspace, ["--connector", "google_calendar", "what is on tuesday"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.connectorCheck.verdict, "unreadable");
  assert.ok(
    payload.warnings.some((w) => /whether the connector catalog loaded is unconfirmed/.test(w)),
    "an unconfirmed check must be said, never passed off as either answer"
  );
});

test("a read-only run is never checked for connectors", () => {
  const { env, workspace } = setup("default", HISTORY_CATALOG_NEVER_LOADED);
  const result = bridge(env, workspace, ["summarize the repo"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).connectorCheck, null);
});

test("a connector run opens exactly the named connectors and pins the approval mode", () => {
  const { env, workspace, fakeGrokLog } = setup();
  // Pin only this launch. The literal `read-only` is the
  // expectation; the confinement assertions below do not depend on the host's kernel.
  env.GROK_CC_LANDLOCK_PROBE = "present";
  env.GROK_CC_CONFINEMENT_PLATFORM = "linux";
  const result = bridge(env, workspace, ["--connector", "google_calendar,notion", "list my week"]);

  assert.equal(result.status, 0, result.stderr);
  const launches = agentLaunches(fakeGrokLog);
  assert.equal(launches.length, 1);
  const { argv, managedMcps } = launches[0];

  assert.deepEqual(flagValues(argv, "--allow"), [
    "MCPTool(google_calendar__*)",
    "MCPTool(notion__*)"
  ]);
  assert.deepEqual(flagValues(argv, "--permission-mode"), ["default"]);
  assert.deepEqual(flagValues(argv, "--sandbox"), ["read-only"]);
  assert.ok(argv.includes("--no-plan"));
  assert.ok(!argv.includes("--always-approve"), "connector mode must never auto-approve");

  const removed = flagValues(argv, "--disallowed-tools")[0].split(",");
  assert.deepEqual(removed, CONNECTOR_DISALLOWED_TOOLS);
  assert.ok(!removed.includes("search_tool") && !removed.includes("use_tool"));
  assert.ok(removed.includes("run_terminal_cmd") && removed.includes("write"));

  assert.deepEqual(flagValues(argv, "--deny").sort(), ["Bash", "Edit", "Write"]);

  assert.deepEqual(managedMcps, {
    GROK_MANAGED_MCPS_ENABLED: "true",
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "true"
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.confinement.mode, "connector");
  assert.deepEqual(payload.confinement.connectors, ["google_calendar", "notion"]);
});

test("a connector run's prompt starts with the bridge's polling note and names the connectors", () => {
  const { env, workspace, fakeGrokLog } = setup();
  const result = bridge(env, workspace, ["--connector", "google_calendar,notion", "list my week"]);

  assert.equal(result.status, 0, result.stderr);
  const [{ argv }] = agentLaunches(fakeGrokLog);
  const prompt = flagValues(argv, "-p")[0];
  assert.match(prompt, /^\[Bridge note\] This run may use only these connectors: google_calendar, notion\./);
  assert.match(prompt, /call search_tool again/);
  assert.match(prompt, /This run is grok-cc-run-[0-9a-f]+\./);
  assert.ok(prompt.endsWith("\n\nlist my week"), "the caller's task must follow the note unchanged");
});

test("a read-only run is untouched: no allow rule, no pinned mode, no connector switches", () => {
  const { env, workspace, fakeGrokLog } = setup();
  const result = bridge(env, workspace, ["summarize the repo"]);

  assert.equal(result.status, 0, result.stderr);
  const [{ argv, managedMcps }] = agentLaunches(fakeGrokLog);
  assert.equal(flagValues(argv, "-p")[0], "summarize the repo", "read-only prompts get no note");
  assert.deepEqual(flagValues(argv, "--allow"), []);
  assert.deepEqual(flagValues(argv, "--permission-mode"), []);
  assert.deepEqual(flagValues(argv, "--disallowed-tools")[0].split(","), READ_ONLY_DISALLOWED_TOOLS);
  assert.deepEqual(flagValues(argv, "--deny").sort(), [...READ_ONLY_DENY_RULES].sort());
  assert.deepEqual(managedMcps, {
    GROK_MANAGED_MCPS_ENABLED: null,
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: null
  });
  assert.equal(JSON.parse(result.stdout).confinement.mode, "read-only");
});

test("a connector run that returns nothing is not retried", () => {
  const { env, workspace, fakeGrokLog } = setup("empty-then-ok");
  const result = bridge(env, workspace, ["--connector", "google_calendar", "create the event"]);

  assert.equal(
    agentLaunches(fakeGrokLog).length,
    1,
    "a second launch could repeat a create that already happened"
  );
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.nudged, false);
  assert.equal(payload.failureCode, "no-deliverable");
});

// ⚠ These assert that grok was not invoked AT ALL — no version or models probe either — and
// match the message only handleTask produces. executeTaskRun has a backstop with a similar
// message, but it fires after the binary was probed and a failed run was recorded; a test that
// accepted either message would stay green with handleTask's own refusal deleted.
for (const [label, extra, message] of [
  ["--write", ["--write"], /--connector cannot be combined with --write: connector mode keeps the read-only toolset/],
  ["--background", ["--background"], /--connector cannot be combined with --background\./]
]) {
  test(`--connector with ${label} is refused before grok starts`, () => {
    const { env, workspace, fakeGrokLog } = setup();
    const result = bridge(env, workspace, ["--connector", "google_calendar", ...extra, "do it"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, message);
    assert.deepEqual(allInvocations(fakeGrokLog), [], "grok must not be invoked at all");
  });
}

test("--connector with --prompts-file is refused before grok starts", () => {
  const { env, workspace, fakeGrokLog } = setup();
  const promptsFile = path.join(workspace, "prompts.ndjson");
  fs.writeFileSync(promptsFile, '"one"\n"two"\n');
  const result = bridge(env, workspace, [
    "--connector",
    "google_calendar",
    "--prompts-file",
    promptsFile
  ]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /--connector cannot be combined with --prompts-file/);
  assert.deepEqual(allInvocations(fakeGrokLog), [], "grok must not be invoked at all");
});

test("an invalid connector name is refused before grok starts", () => {
  const { env, workspace, fakeGrokLog } = setup();
  const result = bridge(env, workspace, ["--connector", "*", "do it"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /--connector takes gateway connector names/);
  assert.deepEqual(allInvocations(fakeGrokLog), [], "grok must not be invoked at all");
});

test("a background worker ignores connectors written into its job record", () => {
  const { env, workspace, pluginDataDir, fakeGrokLog } = setup();
  const jobId = "run-connectortest-aaaa";
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const record = {
      id: jobId,
      status: "queued",
      kind: "task",
      kindLabel: "Run",
      title: "Tampered record",
      jobClass: "task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: { prompt: "hello", cwd: workspace, connectors: ["google_calendar"] }
    };
    writeJobFile(workspace, jobId, record);
    upsertJob(workspace, {
      id: jobId,
      status: "queued",
      kind: "task",
      kindLabel: "Run",
      title: record.title,
      jobClass: "task"
    });
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }

  const result = run(process.execPath, [SCRIPT, "run-worker", "--cwd", workspace, "--job-id", jobId], {
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const [{ argv, managedMcps }] = agentLaunches(fakeGrokLog);
  assert.deepEqual(flagValues(argv, "--allow"), [], "the record must not open a connector");
  assert.ok(flagValues(argv, "--disallowed-tools")[0].split(",").includes("use_tool"));
  assert.deepEqual(flagValues(argv, "--deny").sort(), [...READ_ONLY_DENY_RULES].sort());
  assert.equal(managedMcps.GROK_MANAGED_MCPS_ENABLED, null);
});
