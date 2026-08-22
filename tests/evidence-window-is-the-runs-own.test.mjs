/**
 * A Grok session is not a run. `--thread` and `--resume` reuse the session id deliberately —
 * that reuse is what makes a conversation continue — and the CLI writes every turn's subagents
 * into that one session directory. So reading it whole hands a resumed run the union of every
 * strand ever spawned in the thread, presented as its own fan-out.
 *
 * Measured 2026-08-09 against this machine's production state root: **36 session ids were shared
 * by two or more runs.** A continuation that spawned nothing would have reported another turn's
 * strands as its own, identically on every run of the thread. Found by a full-release code
 * review, in the feature this release headlines.
 *
 * The filter itself is tested against a planted session elsewhere. What this file pins is the
 * WIRING: that the window handed to the reader is the run's own lifetime and not something
 * else. A filter attached to the wrong dates fails exactly as silently as no filter at all.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { withSubagentEvidence } from "../plugins/grok-build/scripts/grok-bridge.mjs";

test("the window handed to the reader is the run's own lifetime", () => {
  const seen = [];
  const spy = (sessionId, options) => {
    seen.push({ sessionId, window: options?.window ?? null });
    return { sessionDir: "/s", strands: [], droppedByCap: 0, fromOtherTurns: 0 };
  };

  const job = {
    id: "run-1",
    threadId: "session-shared-by-many-runs",
    createdAt: "2026-08-09T11:00:00.000Z",
    startedAt: "2026-08-09T12:00:00.000Z",
    completedAt: "2026-08-09T12:05:00.000Z"
  };

  withSubagentEvidence(job, "C:/p", spy);

  assert.equal(seen.length, 1, "the reader must be called once");
  assert.equal(seen[0].sessionId, "session-shared-by-many-runs");
  assert.ok(seen[0].window, "a window must be passed at all — without one the reader returns the whole session");
  assert.equal(seen[0].window.from, "2026-08-09T12:00:00.000Z", "the window starts when THIS run started");
  assert.equal(seen[0].window.to, "2026-08-09T12:05:00.000Z", "and ends when it finished");
});

test("a run that has not finished still gets a lower bound", () => {
  // An open-ended window is correct for a live run — strands are still arriving — but the lower
  // bound must still exclude earlier turns of the same thread.
  const seen = [];
  const spy = (sessionId, options) => {
    seen.push(options?.window ?? null);
    return null;
  };

  withSubagentEvidence(
    { id: "run-2", threadId: "t", startedAt: "2026-08-09T12:00:00.000Z", completedAt: null },
    "C:/p",
    spy
  );

  assert.equal(seen[0].from, "2026-08-09T12:00:00.000Z");
  assert.equal(seen[0].to, null, "an unfinished run has no upper bound, and must not invent one");
});

test("createdAt is the fallback when a run never recorded a start", () => {
  const seen = [];
  const spy = (sessionId, options) => {
    seen.push(options?.window ?? null);
    return null;
  };

  withSubagentEvidence({ id: "run-3", threadId: "t", createdAt: "2026-08-09T09:00:00.000Z" }, "C:/p", spy);

  assert.equal(seen[0].from, "2026-08-09T09:00:00.000Z");
});
