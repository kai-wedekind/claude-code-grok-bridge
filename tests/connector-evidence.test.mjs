/**
 * The connector-catalog check reads the CLI's session history and must only ever call a run
 * "never loaded" on the two shapes a missing catalog produced (grok 1.0.41): use_tool
 * "Tool not found" and search_tool with no
 * tools. Anything it does not recognise must not turn a good run into a failed one.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { classifyConnectorHistory, assessConnectorRun } from "../plugins/grok-build/scripts/lib/connector-evidence.mjs";
import { MAX_FILE_BYTES } from "../plugins/grok-build/scripts/lib/subagents.mjs";

function history(...entries) {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

const call = (id, name) => ({ type: "assistant", tool_calls: [{ id, name, arguments: "{}" }] });
const result = (id, content) => ({ type: "tool_result", tool_call_id: id, content });
const EMPTY_SEARCH = JSON.stringify({ results: [], total_hidden_tools: 0, status: "ready" });

test("not-found tools and empty searches are a catalog that never loaded", () => {
  const verdict = classifyConnectorHistory(
    history(
      call("a", "use_tool"),
      result("a", "Tool `google_calendar__search` failed via `use_tool`: Tool not found: google_calendar__search"),
      call("b", "search_tool"),
      result("b", EMPTY_SEARCH)
    )
  );
  assert.deepEqual(verdict, { verdict: "never-loaded", searchCalls: 1, useCalls: 1, refusedCalls: 0, reason: null });
});

test("an empty first search followed by a search with tools is loaded — the normal race", () => {
  const verdict = classifyConnectorHistory(
    history(
      call("a", "search_tool"),
      result("a", EMPTY_SEARCH),
      call("b", "search_tool"),
      result("b", JSON.stringify({ results: [], total_hidden_tools: 178, status: "ready" }))
    )
  );
  assert.equal(verdict.verdict, "loaded");
});

test("a search result cut short in the history counts as loaded, not as an error", () => {
  const truncated =
    '{\n  "results": [\n    {\n      "server": "google_calendar",\n      "tools": [ … [MCP output truncated: 48211 bytes. Full output written to: C:\\x\\mcp\\call-1.json]';
  const verdict = classifyConnectorHistory(history(call("a", "search_tool"), result("a", truncated)));
  assert.equal(verdict.verdict, "loaded");
});

test("a use_tool call that returned anything but not-found shows the catalog was there", () => {
  const verdict = classifyConnectorHistory(
    history(call("a", "use_tool"), result("a", JSON.stringify({ events: [] })))
  );
  assert.equal(verdict.verdict, "loaded");
});

test("a cancelled use_tool call is no evidence either way", () => {
  const verdict = classifyConnectorHistory(
    history(
      call("a", "use_tool"),
      result("a", "User cancelled the execution for tool `use_tool`"),
      call("b", "search_tool"),
      result("b", EMPTY_SEARCH)
    )
  );
  assert.equal(verdict.verdict, "never-loaded");
});

test("a refusal alone is inconclusive, never a catalog that did not load", () => {
  // A run whose only call the allow rules refused: calling it never-loaded would advise a
  // re-run that could only be refused again.
  const verdict = classifyConnectorHistory(
    history(call("a", "use_tool"), result("a", "User cancelled the execution for tool `use_tool`"))
  );
  assert.deepEqual(verdict, { verdict: "inconclusive", searchCalls: 0, useCalls: 1, refusedCalls: 1, reason: "no-sign" });
});

test("a run without search_tool or use_tool calls is its own verdict", () => {
  const verdict = classifyConnectorHistory(history(call("a", "read_file"), result("a", "text")));
  assert.deepEqual(verdict, { verdict: "no-connector-calls", searchCalls: 0, useCalls: 0, refusedCalls: 0, reason: null });
});

test("unparseable lines and non-string content do not throw", () => {
  const text = [
    "not json",
    JSON.stringify(call("a", "use_tool")),
    JSON.stringify(result("a", [{ type: "text", text: "ok" }]))
  ].join("\n");
  assert.equal(classifyConnectorHistory(text).verdict, "loaded");
  assert.equal(classifyConnectorHistory("").verdict, "no-connector-calls");
});

// Texts copied from cli-1.0.45 tool_calls.rs:509-526, :1926-1978 and
// conversation.rs:2053-2056. A refusal is not catalog evidence. A sibling or a synthetic
// dangling result is not a refusal either.
const REFUSAL_TEXTS = [
  ["policy deny", "Tool `use_tool` was not executed: Auto mode blocked this action."],
  ["reject", "User previously rejected `google_calendar__create_event` in this project for tool `use_tool`"],
  ["user cancelled", "User cancelled the execution for tool `use_tool`"],
  ["mcp unresolved", "MCP permission was not resolved to Allow"]
];
const NO_EVIDENCE_TEXTS = [
  ["sibling permission rejection", "Tool execution cancelled due to earlier permission rejection for tool `use_tool`"],
  ["sibling user cancellation", "Tool execution cancelled due to earlier user cancellation for tool `use_tool`"],
  ["sibling followup", "Tool execution cancelled due to earlier user followup message for tool `use_tool`"],
  ["sibling catch-all", "Tool execution cancelled for tool `use_tool`"],
  ["dangling user", "Tool execution was cancelled by the user (tool `use_tool` was not executed)."],
  ["dangling harness", "Tool execution was halted by the harness (timeout); the tool `use_tool` was not executed."],
  ["followup", "The user elected to avoid running the use_tool tool. The tool was not executed. Please refer to the user's message for next steps."],
  ["file budget", "MCP file input batch budget exceeded"],
  ["preview timeout", "Error: MCP approval preview timed out"],
  ["preview worker", "MCP approval preview worker failed"]
];

for (const [label, text] of REFUSAL_TEXTS) {
  test(`a ${label} use_tool result is a refusal and not a loaded catalog`, () => {
    const alone = classifyConnectorHistory(history(call("a", "use_tool"), result("a", text)));
    assert.deepEqual(alone, { verdict: "inconclusive", searchCalls: 0, useCalls: 1, refusedCalls: 1, reason: "no-sign" });
    const afterEmpty = classifyConnectorHistory(
      history(call("s", "search_tool"), result("s", EMPTY_SEARCH), call("a", "use_tool"), result("a", text))
    );
    assert.deepEqual(afterEmpty, { verdict: "never-loaded", searchCalls: 1, useCalls: 1, refusedCalls: 1, reason: null });
  });
}

for (const [label, text] of NO_EVIDENCE_TEXTS) {
  test(`a ${label} use_tool result is no evidence and not a refusal`, () => {
    const alone = classifyConnectorHistory(history(call("a", "use_tool"), result("a", text)));
    assert.deepEqual(alone, { verdict: "inconclusive", searchCalls: 0, useCalls: 1, refusedCalls: 0, reason: "no-sign" });
    const afterEmpty = classifyConnectorHistory(
      history(call("s", "search_tool"), result("s", EMPTY_SEARCH), call("a", "use_tool"), result("a", text))
    );
    assert.deepEqual(afterEmpty, { verdict: "never-loaded", searchCalls: 1, useCalls: 1, refusedCalls: 0, reason: null });
  });
}

test("a policy denial that mentions tool-not-found is still a refusal", () => {
  // The deny prefix is the call that did not run. The reason text must not flip it to missing.
  const verdict = classifyConnectorHistory(
    history(call("a", "use_tool"), result("a", "Tool `use_tool` was not executed: Tool not found: google_calendar__search"))
  );
  assert.equal(verdict.verdict, "inconclusive");
  assert.equal(verdict.refusedCalls, 1);
});

const MARKER = "grok-cc-run-abc123def456";
const POSITIVE_SEARCH = JSON.stringify({ results: [{ tool_name: "google_calendar__search" }], total_hidden_tools: 1 });
const NOT_FOUND = "Tool `google_calendar__search` failed via `use_tool`: Tool not found: google_calendar__search";

function user(text) {
  return { type: "user", content: [{ type: "text", text }] };
}

function plantHistory(entries, { children = [], raw = null } = {}) {
  const home = makeTempDir();
  const cwd = "C:\\connector-evidence";
  const sessionId = "sess-marker";
  const dir = path.join(home, "sessions", encodeURIComponent(cwd), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const body = raw ?? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  fs.writeFileSync(path.join(dir, "chat_history.jsonl"), body);
  for (const child of children) {
    const childDir = path.join(dir, "subagents", child.id);
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, "meta.json"), child.meta, "utf8");
  }
  return { home, cwd, sessionId };
}

function assess(planted, options = {}) {
  return assessConnectorRun(planted.sessionId, {
    grokHome: planted.home,
    cwd: planted.cwd,
    marker: MARKER,
    since: Date.now() - 1000,
    ...options
  });
}

test("only the lines after the last user line that carries the marker are graded", () => {
  const planted = plantHistory([
    user("earlier turn"),
    call("s", "search_tool"),
    result("s", POSITIVE_SEARCH),
    user(`note. This run is ${MARKER}.`),
    call("e", "search_tool"),
    result("e", EMPTY_SEARCH),
    call("u", "use_tool"),
    result("u", NOT_FOUND),
    user(`second note. This run is ${MARKER}.`),
    call("e2", "search_tool"),
    result("e2", EMPTY_SEARCH)
  ]);
  const verdict = assess(planted);
  assert.equal(verdict.verdict, "never-loaded");
  assert.equal(verdict.reason, null);
  assert.equal(verdict.searchCalls, 1);
  assert.equal(verdict.useCalls, 0);
});

test("a marker that is not on a user line does not open the window", () => {
  const planted = plantHistory([
    user("no marker here"),
    call("s", "search_tool"),
    result("s", `${POSITIVE_SEARCH} ${MARKER}`)
  ]);
  const verdict = assess(planted);
  assert.equal(verdict.verdict, "inconclusive");
  assert.equal(verdict.reason, "marker-missing");
  assert.equal(verdict.searchCalls, 0);
});

test("a history with no marker is inconclusive and is not graded", () => {
  const planted = plantHistory([
    user("plain prompt"),
    call("e", "search_tool"),
    result("e", EMPTY_SEARCH)
  ]);
  const verdict = assess(planted);
  assert.equal(verdict.verdict, "inconclusive");
  assert.equal(verdict.reason, "marker-missing");
  assert.equal(verdict.searchCalls, 0);
});

test("a marker outside the tail that was read is inconclusive", () => {
  // A file past MAX_FILE_BYTES is read from the tail. The marker in the skipped head
  // must not be invented, and the positive search in the tail must not be graded either.
  const markerLine = `${JSON.stringify(user(`This run is ${MARKER}.`))}\n`;
  const pad = `${JSON.stringify({ type: "tool_result", tool_call_id: "pad", content: "x".repeat(MAX_FILE_BYTES) })}\n`;
  const tail = [
    user("later, no marker"),
    call("s", "search_tool"),
    result("s", POSITIVE_SEARCH)
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const planted = plantHistory([], { raw: markerLine + pad + tail });
  const verdict = assess(planted);
  assert.equal(verdict.verdict, "inconclusive");
  assert.equal(verdict.reason, "marker-missing");
  assert.equal(verdict.searchCalls, 0);
});

test("a marker inside the tail is graded even when the tail starts mid-line", () => {
  const pad = `${JSON.stringify({ type: "tool_result", tool_call_id: "pad", content: "x".repeat(MAX_FILE_BYTES) })}\n`;
  const tail = [
    user(`This run is ${MARKER}.`),
    call("e", "search_tool"),
    result("e", EMPTY_SEARCH),
    call("u", "use_tool"),
    result("u", NOT_FOUND)
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const planted = plantHistory([], { raw: pad + tail });
  const verdict = assess(planted);
  assert.equal(verdict.verdict, "never-loaded");
  assert.equal(verdict.reason, null);
  assert.equal(verdict.searchCalls, 1);
  assert.equal(verdict.useCalls, 1);
});

test("an earlier turn's child does not count, and one started in the run does", () => {
  const neverLoaded = [
    user(`This run is ${MARKER}.`),
    call("e", "search_tool"),
    result("e", EMPTY_SEARCH)
  ];
  const earlier = plantHistory(neverLoaded, {
    children: [{ id: "old", meta: JSON.stringify({ started_at: "2020-01-01T00:00:00.000Z" }) }]
  });
  const earlierVerdict = assess(earlier);
  assert.equal(earlierVerdict.verdict, "never-loaded");
  assert.equal(earlierVerdict.reason, null);

  const during = plantHistory(neverLoaded, {
    children: [{ id: "now", meta: JSON.stringify({ started_at: new Date().toISOString() }) }]
  });
  const duringVerdict = assess(during);
  assert.equal(duringVerdict.verdict, "inconclusive");
  assert.equal(duringVerdict.reason, "subagents");
});

test("no connector call keeps its verdict and records that a child started", () => {
  const planted = plantHistory(
    [user(`This run is ${MARKER}.`), call("a", "read_file"), result("a", "file text")],
    { children: [{ id: "now", meta: JSON.stringify({ started_at: new Date().toISOString() }) }] }
  );
  const verdict = assess(planted);
  assert.equal(verdict.verdict, "no-connector-calls");
  assert.equal(verdict.reason, "subagents");
});

// The marker is only ever [A-Za-z0-9-]; anything else is refused up front, so a caller that
// hands over a marker with other characters gets "marker-missing" even when a user line
// carries it verbatim, instead of a window opened on a string the CLI may have escaped
// differently.
test("a marker outside [A-Za-z0-9-] is refused even when a user line carries it", () => {
  for (const odd of ["grok-cc-run-abc.123", "grok-cc-run-*", "grok-cc-run-abc_123", "grok cc run"]) {
    const planted = plantHistory([
      user(`This run is ${odd}.`),
      call("e", "search_tool"),
      result("e", EMPTY_SEARCH)
    ]);
    const verdict = assess(planted, { marker: odd });
    assert.equal(verdict.verdict, "inconclusive", odd);
    assert.equal(verdict.reason, "marker-missing", odd);
    assert.equal(verdict.searchCalls, 0, odd);
  }
  // The same history graded with a marker inside the character set does open the window.
  const planted = plantHistory([
    user(`This run is ${MARKER}.`),
    call("e", "search_tool"),
    result("e", EMPTY_SEARCH)
  ]);
  assert.equal(assess(planted).verdict, "never-loaded");
});

// With no window start, every child directory counts, however old its started_at. Falling
// through to `startedMs >= since` instead would coerce `null` to 0, so only a started_at before
// 1970 tells the two apart: it is the one "old child" that comparison would drop.
test("without a window start, any child counts, however old its started_at is", () => {
  const neverLoaded = [
    user(`This run is ${MARKER}.`),
    call("e", "search_tool"),
    result("e", EMPTY_SEARCH)
  ];
  for (const startedAt of ["2020-01-01T00:00:00.000Z", "1960-01-01T00:00:00.000Z"]) {
    const planted = plantHistory(neverLoaded, {
      children: [{ id: "old", meta: JSON.stringify({ started_at: startedAt }) }]
    });
    const verdict = assess(planted, { since: null });
    assert.equal(verdict.verdict, "inconclusive", startedAt);
    assert.equal(verdict.reason, "subagents", startedAt);
  }
});

test("a child whose started_at cannot be read counts", () => {
  const neverLoaded = [
    user(`This run is ${MARKER}.`),
    call("u", "use_tool"),
    result("u", NOT_FOUND)
  ];
  for (const meta of ["not json", JSON.stringify({ status: "running" })]) {
    const planted = plantHistory(neverLoaded, { children: [{ id: "broken", meta }] });
    const verdict = assess(planted);
    assert.equal(verdict.verdict, "inconclusive");
    assert.equal(verdict.reason, "subagents");
  }
});
