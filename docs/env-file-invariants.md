# `CLAUDE_ENV_FILE` — what the writer must guarantee

This document exists because four rounds of fixing this one function each produced the next defect, and nobody had written down what it was supposed to guarantee. Every audit could therefore only compare the code to its own comments — which is how a claim that was never measured survived a release, and how "does anything actually read this file while we write it" went unasked for four rounds.

**The rule this establishes: every change to the writer is judged against this list, not against the previous version of itself.** A property that is not here is not promised.

⚠ **Not every property here has a gate yet.** The first draft of this file claimed they all did, which was false on the day it was written — in a document whose purpose is to stop unmeasured claims from surviving. The coverage table near the end says which are gated and which are not, and that table is the honest one.

## The setting, in one paragraph

Claude Code inlines the whole of `CLAUDE_ENV_FILE` into every `bash -c` it runs. The file is **shared** — other hooks and tools write their own lines into it, and this plugin does not own it. `handleSessionStart` writes the variables this plugin needs, and SessionStart fires on a fresh session, on resume, and on compaction. On Windows, MSYS2 silently truncates a `bash -c` argument past 8186 characters, which is how the original defect became a broken Bash tool rather than a large file.

---

## A. Content

**A1a — One logical binding per owned name.** After a successful write, each owned variable resolves to the current value when the file is sourced.

**A1b — No stale forms.** No leftover lines for an owned name beyond the intentional pair described in A6. *(A file already bloated by an older append-only build must come back correct in one event — the repair property.)*

**A2a — Foreign lines keep their content and their order among themselves.** Including blank lines. This plugin does not own this file.

**A2b — A foreign line that was after our block is still after our block.** ⚠ Satisfied since the in-place rewrite: the block is re-inserted at the position of the first owned line. The previous implementation appended after all kept lines, so a line another hook wrote *after* ours was silently moved in front of it — and A2 was one number until an audit split it, which is why the single number scored that code as passing.

**A3 — Repeated events with unchanged values do not grow the file.** The original defect. Must hold across an unbounded number of SessionStart, resume and compaction events.

**A4 — The written form survives our own re-parse.** The writer reads the file back on the next event and splits it into lines, so anything it writes must parse back to exactly what it wrote. A value containing a newline must not leave a fragment behind as a top-level line. *(Violating this reintroduces A3 through the back door, and the fragment lands outside the quotes, so it also violates A5.)*

**A5 — Sourcing the file sets the variables and executes nothing else.** For any value, including quotes, backslashes, `$`, backticks, spaces and newlines. A4 is about *our* parser; A5 is about *bash*.

**A6 — The dual consumer format, and its order.** For a value that is a single shell word and does not end in `\`, the writer emits exactly two lines: the bare `NAME=value` **first**, then the quoted `export NAME='…'` **last**. For any other value it emits the quoted export line only, and never a bare line. Swapping the order, quoting the bare line, or emitting the bare line unconditionally are each defects. *(This was load-bearing, documented at length in the code, and absent from the first draft of this list — so nothing here would have failed if someone had deleted it.)*

**A7 — The env write finishes before any other SessionStart work that can block, throw, or run long.** Update checks, network calls and other optional work run after. Moving anything in front of the write puts the host's kill budget inside the write window.

**A8 — A null or empty value does not rewrite the file, and does not clear a prior value.** Removing a variable, if it is ever wanted, must be an explicit operation. *(Consequence, stated so it is a decision and not an accident: a session that loses a variable from its environment keeps the old value in the file, and the next event reports success.)*

**A9 — The next event with valid inputs is a full repair.** After a failed write, a killed process, or a partial update, a later successful event leaves every owned variable current with no duplicates, whatever subset landed last time.

**A10 — All owned variables come from one read and go out in one write.** No intermediate state in which one variable is new and another is old. *(Satisfied since the in-place rewrite. The previous implementation performed one read-modify-write per variable, which doubled every hazard in this document.)*

## B. Failure behaviour

**B1 — A read failure that is not "file absent" must not destroy content.** The write that follows replaces the whole file, so treating an unreadable file as an empty one erases everything it held, including other tools' lines. The correct response is to abort without writing.

**B2 — Any outcome that leaves a variable un-updated is announced on stderr.** Including the B1 abort, which was silent in both candidate designs until 2026-08-11 — B1 and B2 contradicted each other in the first draft of this list and the code had sided with silence. Including the case where every strategy failed. Silence is the failure mode this function keeps rediscovering: it has been fixed three times in three different places here.

**B3 — After the call returns, the file is complete, valid shell.** ⚠ Deliberately weaker than the first draft, which said "no failure path leaves the file as invalid shell" and quietly implied the concurrent case. Concurrency is C1. A process killed mid-write is D3.

**B4 — One variable's failure does not fail the whole hook.** The writer is called unguarded from `handleSessionStart`; a throw exits the hook non-zero and skips the rest. Failing loudly in the log is right; failing the SessionStart is not.

**B5 — A path that is not a writable regular file is refused, not destroyed.** A directory, a fifo, a device. Announce per B2.

**B6 — Content is treated as UTF-8, and a leading BOM does not stop us recognising our own lines.** We never emit a BOM. ✅ **The BOM half is now measured, not assumed** (2026-08-17): `isLineForVar` trims first, and JavaScript's `trim()` counts U+FEFF as whitespace, so `﻿NAME=` and `﻿export NAME=` both match. ⚠ **Do not "correct" this clause** — one audit reported it as false and recommended deleting it, and acting on that would have introduced an error. What genuinely does *not* match is a second space: `export  NAME=` is invisible to the matcher. That form has never been this writer's output, so it is a limit rather than a defect, but it is the real gap in the neighbourhood of the one that was reported. ⚠ Node's `readFileSync(…, "utf8")` replaces invalid sequences rather than throwing, so a file that is not valid UTF-8 is silently mutated by any rewrite. Unmeasured.

**B7 — Work is unbounded.** The writer reads the file whole with no size check: it splits, rebuilds and compares. SessionStart runs against a host kill budget, so a large shared env file can spend that budget on the rewrite. The bound is owed. This is a known gap rather than a promise.

**B8 — The strategy's actual permission requirement is the one that gets checked.** Writing in place needs a writable *file*; building a temp beside it needs a writable *directory*. A host where one holds and the other does not must fail predictably and say which.

## C. Concurrency and readers

**C1 — A reader always sees valid shell. NOT PROMISED.** ⚠ This is the invariant the whole redesign turned on. Nobody has demonstrated that any read overlaps a write. Two independent reviews recommended dropping it as a promise: the atomic implementation degrades to a truncating write in exactly the contended case where a reader is plausible, and the machinery it needs caused *measured* defects (D1, D2, D3) to prevent an unmeasured one.

**What would settle it, none of it a reading exercise:** when Claude Code actually inlines the file relative to the hook's lifetime; whether any concurrent open can be observed under load with `strace` or Process Monitor; and whether kill-during-write is more common than rename-falling-back. Tracked as #57. Until then this stays unpromised, and that is a stated trade rather than a claim that no reader exists.

**C2 — Two concurrent SessionStarts. NOT PROMISED.** Both read, both compute a full replacement, the later write wins and the earlier one's variables are lost. Closing it needs a lock spanning read and write.

**C3 — A foreign process appending while we write. NOT PROMISED.** A whole-file write cannot preserve an append landing between our read and our write. ⚠ Replacing the file by rename makes this strictly worse than writing in place: the rename unlinks the old inode, so a tool holding an open append handle writes into a file with no name.

## D. Filesystem identity

**D1 — The file's permissions are never widened.** It carries a session id. Measured: creating a new inode and renaming it over the target takes a `0600` file to `0644` under umask 022. Writing in place satisfies this by construction, because the inode never changes.

**D2 — A symlink at the path is followed, not replaced.** Measured: writing in place follows the link and updates its target; renaming over the link replaces it with a regular file and leaves the target stale forever. Also satisfied by construction when writing in place.

**D3 — A call that returns leaves no temp artefacts.** ⚠ Weakened from the first draft, which said no artefact survives a process *killed* mid-write — a property the temp+rename implementation cannot hold, and the list would have scored it green. A design with no temp file has nothing to leave behind.

## E. Platform

**E2 — The file works with the shell that will actually source it.** MSYS2 bash on Windows, POSIX bash elsewhere. Measured difference: a line ending CRLF gives a value with a trailing `\r` on POSIX bash 5.2 and a clean value on MSYS2 — so line endings are not cosmetic, and normalising them repairs a value on Linux rather than damaging it.

**E3 — The writer emits LF only.** Reading accepts `\r?\n`. A lone `\r` is not treated as a line separator, so a Mac-classic file is one long line; that is a stated limit, not an accident.

*(The first draft had an E1 — "one behaviour on all platforms, or the difference is written down". That is a rule about this document, not a property of the code, and it now lives at the bottom.)*

## F. Cost

**F1 — An event that changes nothing performs no write.** Precisely: if the computed content equals what is on disk, no create, no write, no rename. Satisfied since the in-place rewrite. Before it, unchanged SessionStarts performed a full read-modify-write each time, paying every hazard above to produce byte-identical content — and since SessionStart fires on resume and compaction, that was the common case rather than the rare one.

---

## The design, and why

**Decided 2026-08-11, after two independent reviews reached it separately.**

Write in place: one read, one computed result for every owned variable, skip when it matches what is on disk, and a plain `writeFileSync` when it does not. No temp file, no rename, no `chmod`, no `realpathSync`, no retry ladder, no fallback branch.

Keep everything in the content and failure layer: the dual format and its order (A6), `shellInert`, the newline collapse (A4), the fail-closed read (B1) **now with the warning B2 requires**, no-throw (B4), foreign-line preservation including position (A2a/A2b), and LF emission (E3).

**What this buys:** D1, D2 and D3 hold by construction rather than by machinery built to repair the damage a rename causes. F1 and A10 become reachable. Roughly sixty lines disappear, and with them the fallback branch that was the only remaining path able to expose a torn read.

**What it costs, stated plainly:** a truncate window on every real content change. That is the same window the current fallback already ships, now on the common path instead of the rare one — and F1 removes most of the occasions on which it opens. If C1 is ever demonstrated, this decision is the one to revisit, and rename is the way back.

⚠ **The reasoning that produced the previous design is instructive and should not be repeated:** each fix was measured against the code it replaced rather than against a stated requirement, so fixing the growth created the torn read, fixing the torn read created the mode and symlink loss, fixing the mode hollowed out its own test, and fixing the temp window created a permissions mismatch between two branches of the same function. Four rounds, each one correct in isolation.

---

## Gate coverage

Honest as of 2026-08-11. "Vacuous" means the test exists and would not fail if the property were removed.

| | Gated? | Note |
|---|---|---|
| A1a, A1b | no | no multi-event repair test |
| A2a | partial | foreign *presence* asserted, not position |
| A2b | yes | `env-file-invariants.test.mjs`, mutation-proven |
| A3 | yes | `env-file-invariants.test.mjs` |
| A4 | yes | `env-file-invariants.test.mjs` |
| A5 | yes | shell-safety suite |
| A6 | yes | but skipped where the bash probe fails |
| A7 | no | |
| A10 | yes | `env-file-invariants.test.mjs`, drives handleSessionStart and counts writes |
| A8, A9 | no | |
| B1 | yes | |
| B2 | yes | read abort in `env-file-read-abort.test.mjs`; write failure in `env-file-write-failure-warns.test.mjs` |
| B3 | partial | |
| B4 | weak | implied by another test completing |
| B5, B6, B8 | no | |
| B7 | n/a | not promised; the writer reads the file whole with no size check |
| C1 | n/a | not promised; the hardlink test proves replacement, which is not the same claim |
| C2, C3 | n/a | not promised |
| D1, D2 | yes | POSIX only, correctly skipped on Windows |
| D3 | partial | after-return gated; kill case not |
| E2, E3 | no | |
| F1 | yes | `env-file-invariants.test.mjs` — counts writes, because content comparison cannot gate it |

⚠ **Four vacuous guards have been found in these files so far**: one that called `test.skip()` inside a body and passed instead of skipping; one hollowed out by a later fix to the code it guarded; one whose title claimed a mechanism its assertion no longer touched; and a helper in the shell-safety suite that never calls the writer at all. Assume a fifth.

## How to use this

**Adding a property:** it goes here first, with the evidence that motivated it, then gets a gate, then gets implemented.

**Changing the implementation:** produce a table of these numbers against the candidates, marking satisfies, violates or untestable. A design satisfying fewer is not automatically worse — C1 was traded deliberately — but the trade has to be visible.

**Auditing:** ask what is *missing from this list*, not whether the code is correct. The second question has no stopping condition; the first one does. That change of question is what produced eleven additions and two violations the previous framing had missed for four rounds.

**One behaviour on all platforms, or the difference is written down here.** Windows is the development host, so Linux and macOS regressions are the likely ones and the least likely to be noticed.

⚠ **Everything marked "measured" was measured on one or two machines, mostly by driving the hook directly rather than through a real session. Observations with a date, not constants.**
