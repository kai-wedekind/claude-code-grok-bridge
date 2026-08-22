/**
 * The strand block exists so a fan-out never looks smaller than it was. These three defects
 * were the same failure reappearing inside the feature meant to prevent it — each one made the
 * summary claim less had happened than actually had. All three were confirmed by an audit on
 * 2026-08-09 and none of them was visible from the tests that shipped with the feature.
 *
 * 1. A strand whose deliverable could not be READ was counted as having "produced nothing",
 *    directly contradicting the `! output.json is larger than …` line printed above it.
 * 2. The status tally listed only completed/failed/cancelled, so a running strand — or one
 *    with no meta.json, which reads as "unknown" — vanished from the breakdown while still
 *    counting in the total. `Subagents: 3 (1 completed)`, and the arithmetic simply failed.
 * 3. A child directory that `readdir` listed but that could not be stat'ed was dropped with no
 *    error and no place in any count, because `isDirectory` answers false for "not a
 *    directory" and for "could not look" alike.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { pushSubagentStrands } from "../plugins/grok-build/scripts/lib/render.mjs";

function strand(over) {
  return {
    id: "child-1", type: "explore", description: "a strand",
    status: "completed", outputChars: 120, output: "x".repeat(120),
    toolCalls: 3, readError: null, ...over
  };
}

function render(evidence) {
  const lines = [];
  pushSubagentStrands(lines, { subagents: evidence });
  return lines.join("\n");
}

test("a strand whose output could not be read is not called empty", () => {
  const text = render({
    sessionDir: "/s",
    strands: [
      strand({ id: "ok-1" }),
      strand({
        id: "too-big",
        outputChars: 0,
        output: null,
        // The KIND matters, not just the presence of an error. `readError` alone covers three
        // different facts — refused for size, present but unparseable, and absent altogether —
        // and only the first has "produced output we declined to read" as a true description.
        readError: "output.json is larger than 8 MiB and was not read",
        readErrorKind: "refused"
      })
    ],
    droppedByCap: 0
  });

  assert.ok(
    !/1 of 2 finished strands produced nothing/.test(text),
    `a refused deliverable is not "nothing":\n${text}`
  );
  assert.match(text, /DID produce output that this bridge declined to read/);
  // And it must not be quietly folded into the delivered side either — that would be the
  // opposite overclaim, and is the reason this asserts the wording rather than a count.
  assert.ok(!/rests on 2/.test(text), `an unread strand is not a delivered one:\n${text}`);
});

test("a genuinely empty strand is still called empty", () => {
  // The control. Without it, "never say produced nothing" would pass the test above.
  const text = render({
    sessionDir: "/s",
    strands: [strand({ id: "ok-1" }), strand({ id: "empty", outputChars: 0, output: "", readError: null })],
    droppedByCap: 0
  });
  assert.match(text, /1 of 2 finished strands produced nothing — this answer rests on 1./);
});

test("the status tally adds up to the strand count", () => {
  const text = render({
    sessionDir: "/s",
    strands: [
      strand({ id: "a", status: "completed" }),
      strand({ id: "b", status: "running" }),
      strand({ id: "c", status: "unknown" })
    ],
    droppedByCap: 0
  });

  const line = text.split("\n").find((l) => l.includes("Subagents:"));
  assert.ok(line, `no summary line in:\n${text}`);
  assert.match(line, /Subagents: 3 /);
  assert.match(line, /2 running or unknown/, `the breakdown must account for all three: ${line}`);

  // Arithmetic, not wording: every number in the parenthetical must sum to the total.
  const total = Number(line.match(/Subagents: (\d+)/)[1]);
  const parts = [...line.matchAll(/(\d+) (?:completed|failed|cancelled|running or unknown)/g)]
    .map((m) => Number(m[1]));
  assert.equal(parts.reduce((a, b) => a + b, 0), total, `breakdown does not sum to the total: ${line}`);
});

test("entries that could not be examined are reported, not dropped", () => {
  const text = render({
    sessionDir: "/s",
    strands: [strand({ id: "a" })],
    droppedByCap: 0,
    unreadableEntries: 2
  });
  assert.match(text, /2 entr\(y\/ies\) were listed .* could not be examined at all/);
});

test("a strand marked completed with no deliverable is empty, not 'produced output'", () => {
  // The third readErrorKind, and the one the earlier wording lied about. `missing` means the
  // CLI called the strand done and left nothing behind — the original defect this whole block
  // exists to surface. Reporting it as "DID produce output that could not be read" dressed an
  // absence up as a refusal. Found by a code review 2026-08-09, hours after that sentence was
  // written to fix the previous version of the same mistake.
  const text = render({
    sessionDir: "/s",
    strands: [
      strand({ id: "ok-1" }),
      strand({
        id: "gone",
        outputChars: 0,
        output: null,
        readError: "status is completed but output.json is absent",
        readErrorKind: "missing"
      })
    ],
    droppedByCap: 0
  });

  assert.match(text, /1 of 2 finished strands produced nothing/, `a missing deliverable is empty:
${text}`);
  assert.ok(!/DID produce output/.test(text), `nothing was produced, so do not say it was:
${text}`);
});

test("a strand still running has not 'produced nothing' — it has not finished", () => {
  // Reproduced at HEAD by a code review 2026-08-09: `runs <id>` on a live job announced
  // "3 of 3 strands produced nothing — this answer rests on 0" directly beneath a tally that
  // correctly said "3 running or unknown". Two lines about the same three strands, disagreeing,
  // and the wrong one is the one a reader takes as the verdict. A non-terminal strand belongs
  // in neither the delivered nor the empty column.
  const text = render({
    sessionDir: "/s",
    strands: [
      strand({ id: "a", status: "running", outputChars: 0, output: null }),
      strand({ id: "b", status: "running", outputChars: 0, output: null }),
      strand({ id: "c", status: "unknown", outputChars: 0, output: null })
    ],
    droppedByCap: 0
  });

  assert.ok(!/produced nothing/.test(text), `nothing has finished yet:
${text}`);
  assert.match(text, /3 strand\(s\) had not finished when this was read/);
});

test("strands from another turn of the same thread are excluded and named", () => {
  // A session outlives a run whenever --thread or --resume is used, and the CLI writes every
  // turn's subagents into the one session directory. Measured 2026-08-09: 36 session ids on
  // this machine were shared by two or more runs. Without the window filter, a continuation
  // that spawned nothing reported the whole thread's history as its own fan-out.
  const text = render({
    sessionDir: "/s",
    strands: [strand({ id: "mine" })],
    droppedByCap: 0,
    fromOtherTurns: 4
  });
  assert.match(text, /4 strand\(s\) in this session belong to other turns/);
});
