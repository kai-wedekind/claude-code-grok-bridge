import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveGrokHome,
  findSessionDir,
  readSubagentStrands,
  collectSubagentEvidence,
  MAX_STRAND_OUTPUT_CHARS,
  MAX_STRANDS
} from "../plugins/grok-build/scripts/lib/subagents.mjs";

// Build the layout the CLI actually writes. Field names come from a real record measured
// 2026-08-09 (run 82c1dd7c), not from the CLI README — the README's storage section claims
// children hold `updates.jsonl`, and on disk they hold `meta.json` plus `output.json`.
function plantSession(home, cwd, sessionId, children) {
  const dir = path.join(home, "sessions", encodeURIComponent(cwd), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (const child of children) {
    const childDir = path.join(dir, "subagents", child.id);
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(
      path.join(childDir, "meta.json"),
      JSON.stringify({
        subagent_id: child.id,
        child_session_id: child.id,
        parent_session_id: sessionId,
        subagent_type: child.type ?? "explore",
        description: child.description ?? "a strand",
        prompt: child.prompt ?? "do the thing",
        status: child.status ?? "completed",
        started_at: child.startedAt ?? "2026-08-09T00:00:00.000000000Z",
        completed_at: "2026-08-09T00:01:00.000000000Z",
        duration_ms: 60000,
        tool_calls: child.toolCalls ?? 7,
        turns: 1,
        capability_mode: "read-only",
        effective_model_id: "grok-4.5"
      }),
      "utf8"
    );
    if (child.output !== undefined) {
      fs.writeFileSync(
        path.join(childDir, "output.json"),
        JSON.stringify({ schema_version: 1, output: child.output }),
        "utf8"
      );
    }
    if (child.corruptOutput) {
      fs.writeFileSync(path.join(childDir, "output.json"), "{not json at all", "utf8");
    }
  }
  return dir;
}

test("resolveGrokHome prefers GROK_HOME and falls back to the default", () => {
  assert.equal(resolveGrokHome({ GROK_HOME: "C:/elsewhere/.grok" }), "C:/elsewhere/.grok");
  // Blank must not win — an empty variable is not a choice of location.
  assert.match(resolveGrokHome({ GROK_HOME: "   " }), /\.grok$/);
  assert.match(resolveGrokHome({}), /\.grok$/);
});

test("findSessionDir locates a session through the encoded-cwd fast path", () => {
  const home = makeTempDir();
  const cwd = "C:\\Users\\someone\\project";
  const planted = plantSession(home, cwd, "sess-fast", [{ id: "a", output: "x" }]);
  const found = findSessionDir("sess-fast", { grokHome: home, cwd });
  assert.equal(found, planted);
});

test("findSessionDir still finds the session when the cwd does not match", () => {
  // This is the guarantee, not a nicety. The URL encoding is upstream's and can change,
  // and the cwd the bridge recorded need not be byte-identical to the one the CLI encoded.
  // Without the fallback scan, a miss is indistinguishable from "this run had no subagents".
  const home = makeTempDir();
  const planted = plantSession(home, "C:\\real\\path", "sess-scan", [{ id: "a", output: "x" }]);

  const wrongCwd = findSessionDir("sess-scan", { grokHome: home, cwd: "C:\\totally\\different" });
  assert.equal(wrongCwd, planted, "a wrong cwd must not hide the session");

  const noCwd = findSessionDir("sess-scan", { grokHome: home });
  assert.equal(noCwd, planted, "no cwd at all must not hide the session");
});

test("findSessionDir returns null rather than guessing", () => {
  const home = makeTempDir();
  plantSession(home, "C:\\real\\path", "sess-real", [{ id: "a", output: "x" }]);
  assert.equal(findSessionDir("sess-absent", { grokHome: home }), null);
  assert.equal(findSessionDir("", { grokHome: home }), null);
  assert.equal(findSessionDir(null, { grokHome: home }), null);
  assert.equal(findSessionDir("sess-real", { grokHome: path.join(home, "nope") }), null);
});

test("readSubagentStrands returns every strand in spawn order", () => {
  const home = makeTempDir();
  const dir = plantSession(home, "C:\\p", "s", [
    { id: "second", output: "B", startedAt: "2026-08-09T00:00:02.000000000Z", description: "two" },
    { id: "first", output: "A", startedAt: "2026-08-09T00:00:01.000000000Z", description: "one" },
    { id: "third", output: "C", startedAt: "2026-08-09T00:00:03.000000000Z", description: "three" }
  ]);
  const strands = readSubagentStrands(dir);
  assert.deepEqual(
    strands.map((s) => s.description),
    ["one", "two", "three"],
    "order must come from started_at, not from readdir"
  );
  assert.equal(strands[0].model, "grok-4.5");
  // meta.json in the plant still carries capability_mode, and the reader must not
  // surface it. SubagentMeta never persists the field (cli-1.0.45 mod.rs:2101-2154).
  assert.equal("capabilityMode" in strands[0], false);
  assert.equal(strands[0].toolCalls, 7);
  assert.equal(strands[0].outputChars, 1);
  assert.equal(strands[0].truncated, false);
  assert.equal(strands[0].readError, null);
});

test("a strand marked completed with no deliverable is reported, never dropped", () => {
  // Dropping it restores exactly the condition this module replaces: a fan-out that looks
  // smaller than it was, with nothing saying so.
  const home = makeTempDir();
  const dir = plantSession(home, "C:\\p", "s", [
    { id: "good", output: "fine" },
    { id: "empty", status: "completed" },
    { id: "broken", corruptOutput: true }
  ]);
  const strands = readSubagentStrands(dir);
  assert.equal(strands.length, 3, "every child must appear");

  const empty = strands.find((s) => s.id === "empty");
  assert.match(empty.readError, /completed but output\.json is absent/);

  const broken = strands.find((s) => s.id === "broken");
  assert.match(broken.readError, /no readable `output` string/);

  const good = strands.find((s) => s.id === "good");
  assert.equal(good.readError, null);
});

test("a failed strand with no output is not treated as an error", () => {
  // 44 % of real strands fail. A failure that produced nothing is the expected
  // shape of a failure, so flagging it as a read error would bury the ones that matter.
  const home = makeTempDir();
  const dir = plantSession(home, "C:\\p", "s", [{ id: "f", status: "failed" }]);
  const [strand] = readSubagentStrands(dir);
  assert.equal(strand.status, "failed");
  assert.equal(strand.readError, null);
  assert.equal(strand.output, null);
});

test("an oversized deliverable is capped and says so", () => {
  const home = makeTempDir();
  const big = "x".repeat(MAX_STRAND_OUTPUT_CHARS + 500);
  const dir = plantSession(home, "C:\\p", "s", [{ id: "big", output: big }]);
  const [strand] = readSubagentStrands(dir, { maxOutputChars: 100 });
  assert.equal(strand.output.length, 100);
  assert.equal(strand.truncated, true);
  assert.equal(
    strand.outputChars,
    big.length,
    "the true size must survive the cap, or the record understates what exists"
  );
  assert.ok(strand.sourceDir.endsWith("big"), "the full copy on disk must stay findable");

  // ⚠ The option is not the thing that ships. This test only ever passed `maxOutputChars`,
  // so an implementation that honoured the option and ignored the DEFAULT would have gone
  // green — and the default is what every real caller gets. Audit 2026-08-09.
  const [byDefault] = readSubagentStrands(dir);
  assert.equal(byDefault.output.length, MAX_STRAND_OUTPUT_CHARS);
  assert.equal(byDefault.truncated, true);
  assert.equal(byDefault.outputChars, big.length);
});

test("a session id that is a path segment attack is refused, not resolved", () => {
  // `findSessionDir("..")` used to normalise to the sessions ROOT and report it as a
  // session — `path.join` resolves `..` before `isDirectory` ever sees it, so the guard has
  // to reject the id rather than test the result. `state.mjs` refuses the same shapes in
  // `assertValidSessionId`; today's ids come from our own state file, which is exactly why
  // this is cheap insurance and not paranoia. Audit 2026-08-09.
  const home = makeTempDir();
  plantSession(home, "C:\\p", "real", [{ id: "a", output: "x" }]);

  for (const hostile of ["..", ".", "../..", "..\\..", "a/b", "a\\b", "/etc", "C:\\Windows"]) {
    assert.equal(
      findSessionDir(hostile, { grokHome: home }),
      null,
      `must refuse ${JSON.stringify(hostile)} rather than resolve it`
    );
  }
  assert.ok(findSessionDir("real", { grokHome: home }), "an ordinary id must still resolve");
});

test("non-directory entries do not spend the strand budget", () => {
  // The cap used to be applied to the raw listing, so a stray file — a lock, a .DS_Store,
  // anything a backup tool drops in — could consume it and push real strands off the end
  // with nothing saying so. Filter first, cap second. Audit 2026-08-09.
  const home = makeTempDir();
  const dir = plantSession(home, "C:\\p", "s", [{ id: "zzz-real", output: "kept" }]);
  const subDir = path.join(dir, "subagents");
  for (let i = 0; i < MAX_STRANDS + 5; i += 1) {
    fs.writeFileSync(path.join(subDir, `000-junk-${String(i).padStart(3, "0")}.tmp`), "", "utf8");
  }

  const strands = readSubagentStrands(dir);
  assert.equal(strands.length, 1, "junk sorting ahead of a real child must not hide it");
  assert.equal(strands[0].output, "kept");
});

test("strands dropped by the cap are counted, not silently swallowed", () => {
  const home = makeTempDir();
  const children = [];
  for (let i = 0; i < MAX_STRANDS + 3; i += 1) {
    children.push({ id: `child-${String(i).padStart(3, "0")}`, output: "x" });
  }
  plantSession(home, "C:\\p", "many", children);

  const evidence = collectSubagentEvidence("many", { grokHome: home });
  assert.equal(evidence.strands.length, MAX_STRANDS);
  assert.equal(evidence.droppedByCap, 3, "the caller must be able to see what was left out");
});

test("readSubagentStrands is quiet about sessions that never fanned out", () => {
  const home = makeTempDir();
  const dir = plantSession(home, "C:\\p", "s", []);
  assert.deepEqual(readSubagentStrands(dir), []);
  assert.deepEqual(readSubagentStrands(path.join(home, "does-not-exist")), []);
  assert.deepEqual(readSubagentStrands(null), []);
});

test("collectSubagentEvidence summarises a run and stays null when there was no fan-out", () => {
  const home = makeTempDir();
  plantSession(home, "C:\\p", "with-fanout", [
    { id: "a", output: "aaaa", status: "completed" },
    { id: "b", output: "bb", status: "completed" },
    { id: "c", status: "failed" }
  ]);
  plantSession(home, "C:\\p", "no-fanout", []);

  const evidence = collectSubagentEvidence("with-fanout", { grokHome: home });
  assert.equal(evidence.strands.length, 3);
  assert.equal(evidence.completed, 2);
  assert.equal(evidence.failed, 1);
  assert.equal(evidence.totalChars, 6);
  assert.ok(evidence.sessionDir.endsWith("with-fanout"));

  assert.equal(collectSubagentEvidence("no-fanout", { grokHome: home }), null);
  assert.equal(collectSubagentEvidence("never-existed", { grokHome: home }), null);
});

test("end to end: a planted fan-out reaches the rendered result", async () => {
  // ⚠ Everything above tests the reader OR the renderer. Nothing tested them together, so
  // R08's actual claim — that a real fan-out on disk becomes visible in what a user reads —
  // rested on two green halves and an assumption about the join. Audit 2026-08-09.
  const { renderStoredJobResult } = await import("../plugins/grok-build/scripts/lib/render.mjs");
  const home = makeTempDir();
  plantSession(home, "C:\p", "e2e-session", [
    { id: "a", output: "STRAND-A-FINDINGS", status: "completed", description: "read the issues" },
    { id: "b", status: "failed", description: "audit probes" }
  ]);

  // The join the bridge performs: evidence from disk, attached to the job, then rendered.
  const evidence = collectSubagentEvidence("e2e-session", { grokHome: home });
  assert.ok(evidence, "the planted fan-out must be found by session id alone");

  const job = { id: "run-e2e", status: "completed", threadId: "e2e-session", subagents: evidence };
  const rendered = renderStoredJobResult(job, { rendered: "the synthesis" });

  assert.match(rendered, /the synthesis/);
  assert.match(rendered, /Subagents: 2 \(1 completed, 1 failed\)/);
  assert.match(rendered, /read the issues/);
  assert.match(rendered, /1 of 2 finished strands produced nothing/);
  assert.doesNotMatch(rendered, /STRAND-A-FINDINGS/, "summary view withholds the deliverables");

  const full = renderStoredJobResult(job, { rendered: "the synthesis" }, { showStrandOutput: true });
  assert.match(full, /STRAND-A-FINDINGS/, "--strands must print what is on disk");
});
