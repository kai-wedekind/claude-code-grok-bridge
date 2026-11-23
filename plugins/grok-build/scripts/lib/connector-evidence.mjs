/**
 * Did a connector run ever see its connectors?
 *
 * A headless Grok CLI loads the managed-gateway connector catalog in the background after the
 * session starts. Usually it lands within seconds; on 2026-09-23 it once did not land at all
 * (grok 1.0.41): three use_tool calls answered "Tool not found", five search_tool polls over
 * about 48 s answered no tools, and the run still ended with a confident, normal-looking reply
 * — exit 0, failureCode null. The CLI's own logs said nothing about why; only the session
 * history showed it.
 *
 * The bridge's result carries no tool calls, so the only place the difference is visible is the
 * CLI's session history. This reads it and answers one narrow question. It is deliberately
 * conservative: only a positive sign counts as "loaded", and only the two shapes seen in that
 * failure count against it, so a result format this does not recognise can never turn a good
 * run into a failed one. Refusals and the CLI's other not-executed results are neither.
 */
import fs from "node:fs";
import path from "node:path";

import { findSessionDir, MAX_FILE_BYTES } from "./subagents.mjs";

// The two shapes a missing catalog produced. A use_tool call to a connector tool the session
// does not know: "Tool `google_calendar__search` failed via `use_tool`: Tool not found: …".
const TOOL_NOT_FOUND = /Tool not found:/;

// Strings copied from cli-1.0.45. A refusal says nothing about the catalog.
// PolicyDeny continues the turn (tool_calls.rs:1923-1946); Reject ends it (tool_calls.rs:1928,
// turn.rs:3824-3834). The measured cancel is tool_calls.rs:1956-1958. "MCP permission was not
// resolved to Allow" is tool_calls.rs:1974-1981 and also continues.
const USER_CANCELLED = /User cancelled the execution for tool `use_tool`/;
const POLICY_DENY = /^Tool `use_tool` was not executed: /;
const MCP_UNRESOLVED = "MCP permission was not resolved to Allow";
const REJECT_SUFFIX = / for tool `use_tool`$/;

// Siblings of a call that already ended the batch (tool_calls.rs:504-531) and the synthetic
// dangling-call texts (xai-grok-sampling-types conversation.rs:2049-2058) never ran, but they
// are not the refusal itself. The follow-up text is tool_calls.rs:1966-1968. The file-budget
// and approval-preview strings are what tool_calls.rs:551-557 and :1733-1738 push: the budget
// error is the literal at mcp_file_input.rs:211, and the preview path passes acp::Error's
// Display with the data strings at mcp_file_input.rs:263 and :279 (Display itself is not in
// the 1.0.45 tree, so those data strings are matched as substrings).
const SIBLING = /^Tool execution cancelled (?:due to earlier .+ )?for tool `use_tool`$/;
const DANGLING_USER = "Tool execution was cancelled by the user (tool `use_tool` was not executed).";
const DANGLING_HARNESS = /^Tool execution was halted by the harness \(.+\); the tool `use_tool` was not executed\.$/;
const FOLLOWUP = /^The user elected to avoid running the use_tool tool\. The tool was not executed\./;
const NO_EVIDENCE_SNIPPETS = [
  "MCP file input batch budget exceeded",
  "MCP approval preview timed out",
  "MCP approval preview worker failed"
];

function contentText(content) {
  if (typeof content === "string") {
    return content;
  }
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return "";
  }
}

// A search_tool result is positive evidence when it lists any tool or counts hidden ones, and
// negative evidence only when it parses as an empty catalog. A large result is cut short in the
// history ("[MCP output truncated …]") and no longer parses; only a result with tools in it gets
// that large, so the text fallback reads it as positive. Anything else is no evidence.
function searchEvidence(text) {
  try {
    const parsed = JSON.parse(text);
    const results = Array.isArray(parsed?.results) ? parsed.results : null;
    if ((results && results.length > 0) || Number(parsed?.total_hidden_tools) > 0) {
      return "positive";
    }
    return results && results.length === 0 ? "negative" : "none";
  } catch {
    return /"tool_name"/.test(text) || /"total_hidden_tools":\s*[1-9]/.test(text) || /MCP output truncated/.test(text)
      ? "positive"
      : "none";
  }
}

// "refused" counts the call and says nothing about the catalog. "none" counts the call and
// says nothing at all. Checked in this order because a sibling ends in the same
// "for tool `use_tool`" suffix as a Reject.
function useToolClass(text) {
  if (
    SIBLING.test(text) ||
    text === DANGLING_USER ||
    DANGLING_HARNESS.test(text) ||
    FOLLOWUP.test(text) ||
    NO_EVIDENCE_SNIPPETS.some((snippet) => text.includes(snippet))
  ) {
    return "none";
  }
  if (USER_CANCELLED.test(text) || POLICY_DENY.test(text) || text === MCP_UNRESOLVED || REJECT_SUFFIX.test(text)) {
    return "refused";
  }
  if (TOOL_NOT_FOUND.test(text)) {
    return "missing";
  }
  return "loaded";
}

/**
 * Classify the tool activity recorded in a session's chat_history.jsonl text.
 *
 * "never-loaded" needs NEGATIVE evidence — an empty search or a not-found tool — and no positive
 * sign; a run with calls but neither (only refusals, say) is "inconclusive" with reason "no-sign".
 *
 * @returns {{verdict: "loaded"|"never-loaded"|"inconclusive"|"no-connector-calls", searchCalls: number, useCalls: number, refusedCalls: number, reason: string|null}}
 */
export function classifyConnectorHistory(historyText) {
  const callNames = new Map();
  let searchCalls = 0;
  let useCalls = 0;
  let refusedCalls = 0;
  let loaded = false;
  let missing = false;

  for (const line of String(historyText ?? "").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(entry?.tool_calls)) {
      for (const call of entry.tool_calls) {
        if (call?.id) {
          callNames.set(call.id, call.name);
        }
      }
    }
    if (entry?.type !== "tool_result") {
      continue;
    }
    const name = callNames.get(entry.tool_call_id);
    const text = contentText(entry.content);
    if (name === "search_tool") {
      searchCalls += 1;
      const evidence = searchEvidence(text);
      if (evidence === "positive") {
        loaded = true;
      } else if (evidence === "negative") {
        missing = true;
      }
    } else if (name === "use_tool") {
      useCalls += 1;
      const kind = useToolClass(text);
      if (kind === "refused") {
        refusedCalls += 1;
      } else if (kind === "missing") {
        missing = true;
      } else if (kind === "loaded") {
        loaded = true;
      }
    }
  }

  const verdict = loaded
    ? "loaded"
    : missing
      ? "never-loaded"
      : searchCalls + useCalls === 0
        ? "no-connector-calls"
        : "inconclusive";
  return { verdict, searchCalls, useCalls, refusedCalls, reason: verdict === "inconclusive" ? "no-sign" : null };
}

const HISTORY_FILE = "chat_history.jsonl";

function counts(verdict, reason, sessionDir, extra = {}) {
  return {
    verdict,
    searchCalls: 0,
    useCalls: 0,
    refusedCalls: 0,
    reason,
    sessionDir,
    ...extra
  };
}

/**
 * Lines of this run only: everything after the last user item that contains `marker`.
 *
 * The CLI persists the prompt verbatim as a user item (cli-1.0.45 conversation.rs:974-978,
 * turn.rs:1216-1217, pushed at mutations.rs:330). It does not append on resume: every spawn
 * rewrites chat_history.jsonl (spawn.rs:1459-1463), and retained pruning replaces aged tool
 * results with the placeholder at request_builder.rs:14 and rewrites the file again
 * (mutations.rs:338-389). A byte offset taken beforehand therefore lands inside the wrong
 * turn in both directions. The marker is only `[A-Za-z0-9-]`, so a
 * substring test cannot be confused with a JSON escape.
 *
 * A file longer than MAX_FILE_BYTES is read from the tail only. The marker not being in that
 * tail is inconclusive, not a guess about the head that was skipped.
 */
function sliceAfterMarker(text, marker) {
  if (typeof marker !== "string" || !/^[A-Za-z0-9-]+$/.test(marker)) {
    return null;
  }
  const lines = String(text).split("\n");
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(marker)) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "user") {
      anchor = i;
    }
  }
  if (anchor < 0) {
    return null;
  }
  return lines.slice(anchor + 1).join("\n");
}

/**
 * Locate the run's session history and classify what this run recorded after its own marker.
 *
 * `marker` is the token the bridge put in this run's prompt. `since` (ms) is when the run
 * started. `verdict: "unreadable"` means the history could not be found or read — reported,
 * never treated as either answer. A missing marker is "inconclusive" (reason "marker-missing"):
 * grading the whole file would let an earlier turn vouch for this one, which is the bug the
 * marker exists to close. A "never-loaded" or "no-connector-calls" run that spawned a subagent
 * during this run is not a claim about calls this check never saw.
 */
export function assessConnectorRun(sessionId, options = {}) {
  const { marker = null, since = null } = options;
  const sessionDir = findSessionDir(sessionId, options);
  if (!sessionDir) {
    return counts("unreadable", "unreadable", null);
  }
  const historyPath = path.join(sessionDir, HISTORY_FILE);
  let text;
  try {
    const size = fs.statSync(historyPath).size;
    const start = size > MAX_FILE_BYTES ? size - MAX_FILE_BYTES : 0;
    const fd = fs.openSync(historyPath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return counts("unreadable", "unreadable", sessionDir);
  }
  const window = sliceAfterMarker(text, marker);
  if (window == null) {
    return counts("inconclusive", "marker-missing", sessionDir);
  }
  const result = { ...classifyConnectorHistory(window), sessionDir };
  if (
    (result.verdict === "never-loaded" || result.verdict === "no-connector-calls") &&
    spawnedSubagentsSince(sessionDir, since)
  ) {
    // never-loaded must not become "safe to re-run" when a child's calls were never read.
    // no-connector-calls keeps its verdict: the parent really made none, and the warning
    // says the children were not checked (reason "subagents").
    if (result.verdict === "never-loaded") {
      return { ...result, verdict: "inconclusive", reason: "subagents" };
    }
    return { ...result, reason: "subagents" };
  }
  return result;
}

// Directory mtime moves when the CLI heals an orphaned child on resume
// (it rewrites meta.json and never started_at — cli-1.0.45 agent/subagent/mod.rs:2440-2446).
// On grok 1.0.52 a read-only or connector run cannot spawn a child through a tool call at all
// (measured 2026-10-15: the bare Edit deny rule refuses the task tool with "Denied by
// permission policy: deny rule on edit"), so this branch is defensive.
function spawnedSubagentsSince(sessionDir, since) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(sessionDir, "subagents"), { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.isDirectory()) {
      return false;
    }
    if (since == null) {
      return true;
    }
    const metaPath = path.join(sessionDir, "subagents", entry.name, "meta.json");
    let startedMs = NaN;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (typeof meta?.started_at === "string") {
        // chrono writes nanoseconds; V8's Date.parse keeps the millisecond prefix.
        startedMs = Date.parse(meta.started_at);
      }
    } catch {
      // A child directory with no readable meta was not healed into an old started_at.
      // Counting it is the failure direction that does not hide a fan-out.
      return true;
    }
    if (Number.isNaN(startedMs)) {
      return true;
    }
    return startedMs >= since;
  });
}
