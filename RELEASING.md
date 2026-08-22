# Releasing

## Disclosure rule for release notes

This is a fork. Some of what gets fixed here is fixed in code that upstream still ships unchanged, so a release note can be two things at once: a description of what improved for you, and a working description of a defect that is still live in somebody else's software.

**The rule, decided 2026-08-09:**

> Describe the fix, never the defect, for any file `check-disclosure.mjs` marks INHERITED — unless it has already been reported upstream and closed or published, in which case name it plainly and link the report. Run the checker as part of writing every release's notes.

Run it against the range you are writing notes for:

```bash
node scripts/check-disclosure.mjs --since <previous-tag-or-sha>
```

## Writing the notes: capture them as you go, do not reconstruct them

**Every change to shipped code leaves a fragment in `changelog.d/`, at the time you make it.** See `changelog.d/README.md`; it is the `towncrier` / `changesets` convention in one dependency-free script.

```bash
node scripts/changelog.mjs check                      # while working
node scripts/changelog.mjs assemble --version 0.4.0   # at release
```

⚠ **This exists because the release-time approach failed, and failed quietly.** The 0.3.3 notes were drafted from memory of a fortnight's work and then filtered by "was this code public before the last release?" — a question that is correct for a **bug** and useless for a **feature**, since a new feature is never public before. The churn was cut correctly and the features were invisible: the update notifier, this plugin's first outbound network request, went missing along with eight other user-visible items, and only human review caught it.

The type `internal` is the load-bearing part: it records "this was in-cycle churn, deliberately not in the notes" as an act. Silence cannot distinguish that from having forgotten.

### The backstop

```bash
node scripts/check-changelog-covers-roadmap.mjs --roadmap <path-to-the-internal-roadmap.html>
```

**Everything on the roadmap goes into the changelog, except a bug that the same cycle's roadmap work introduced. A new feature can never be missed.**

⚠ **The tempting shortcut is wrong, and it fails silently.** Writing the notes from what you remember doing, then filtering by "was this code public before the last release?", cuts the in-cycle churn correctly — and cannot surface a feature at all, because a new feature is never public before. In 0.3.3 that left out the update notifier, which makes this plugin's first outbound network request, along with eight other user-visible items. It took two rounds of human correction to notice. The filter is right for BUGS and useless for FEATURES; the roadmap is what knows the difference.

The checker exits **1** when a shipped roadmap item is neither in the notes nor excluded with a stated reason, **0** when every one is accounted for, and **2** when it could not check — the roadmap is an internal artifact and lives outside this repository, so a missing `--roadmap` is a gap rather than a pass. An item that genuinely does not belong in user-facing notes goes in the checker's `EXCLUDED` map *with the reason*, so the decision is recorded instead of forgotten.

It cannot tell you whether an entry is well written. It tells you that nothing shipped in silence.

It classifies every changed file as INHERITED (byte-identical to upstream before this release, so a note about it reaches upstream's users too) or ours (already diverged, or absent upstream, so it discloses nothing). Exit 1 means at least one INHERITED file changed — that is a prompt to check the wording, not a failure.

**Why the escape hatch matters.** Most of these end up public anyway: a defect reported and closed, or filed as an issue, is already readable by anyone. Suppressing it then costs honesty for no protection, and leaves our own users unable to tell whether their upgrade matters. Name it and link the report.

**Why "describe the fix" is not evasion.** The note still tells you what changed and whether to upgrade. What it omits is the reproduction — the part that is only useful to somebody attacking an unpatched install.

Worked example, 0.3.3: 34 files changed, 2 marked INHERITED. `prompts/critique.md` was only unwrapped, and `lib/claude-session-transfer.mjs` was deleted outright — it existed solely to declare a variable that nothing had read since the import command was removed in `0eed7ce`. Neither note describes a defect, so neither needed the rule applied. The two that would have — the `isMain` symlink no-op and the `CLAUDE_ENV_FILE` growth — were both reported upstream first and are public, so they are named plainly.

## Measuring, when the number is going to be published

Release notes and upstream pull requests carry numbers, and a number in public gets reproduced by somebody with a different machine. Everything here was learned on 2026-08-10, when two independent audits of one ten-line change went through the probes behind it as carefully as through the code — and found more wrong with the probes.

⚠ **A column that cannot vary is not evidence, and its zero is forged rather than merely uninformative.** One probe reported `readerTorn=0/324` for three configurations and it was quoted three times as corroboration. It could never have been anything but zero: every write wrote the same bytes, so the comparison had no observable to fire on, and the reader's bare `catch {}` swallowed read errors without counting them — so an error storm would have rendered as a clean run with a slightly lower read count. Before quoting a zero, ask what would have had to happen for it to be non-zero, and check that the probe could have seen it.

⚠ **A detector must not be able to match its own diagnostic output.** A probe here printed `STILL VULNERABLE` against a fix that worked, because it searched the run's stdout for a marker string and the run legitimately *echoed the variable's value*, which contained the marker. The evidence one line above — a stable file size and a correctly quoted single line — said the opposite. Prefer a side effect that cannot be faked by a print: have the payload `touch` a file and test for the file.

⚠ **Sub-tick sleeps do not happen on Windows.** `Atomics.wait` is pinned to the system timer tick: a requested 5 ms costs 15.368 ms, 3 ms costs 15.398, 2 ms costs 15.423. A probe that claims a "~5 ms cadence" contended about three times less than it says, and a retry ladder whose comment promises "2 ms then 4 ms" really waits about 31 ms in the worst case. Measure the cadence you actually got rather than the one you asked for; to go below the tick, spin on `process.hrtime.bigint()`.

⚠ **Race counts are not rates.** The same unmodified probe gave 739, 1832, 812 and 2128 torn reads across identical runs on two machines with no parameter changed — a 2.9x spread. Publishing one of those to three significant figures invites a reader to reproduce it and get triple. Report the spread, or report only that the effect appeared on every run. Related: check that the denominator means what the table implies. A `writes` column counting *attempts* sat directly beneath one counting *replacements*, and roughly three quarters of the attempts in that row were abandoned before touching the file.

⚠ **Inode numbers are reused, so they cannot prove a file was replaced.** Four consecutive SessionStarts here showed a constant inode while the file was in fact being replaced every time — ext4 handed the freed number straight back. The test that settles it does not depend on inode numbering at all: hard-link the file first, then check whether the link still holds the old content. If it does, the write replaced the file; if it tracked the change, the write went through the existing inode.

⚠ **An amplified demonstration is not a measurement of the real thing, and should say which it is.** A 1.38 MB payload was used to make a truncation window easy to observe on a file that actually holds a few hundred bytes. That is a legitimate way to show a window exists — but presented under a heading about evidence it reads as the risk at hand. Where the effect is visible at the real size, measure it there; where it is not, say that the argument is an invariant rather than a frequency.

## Gates that cannot fail

A guard is only worth what its own failure proves. Three ways one can look green while checking nothing, all found here on 2026-08-10 and 2026-08-11, two of them in guards written specifically to stop that from happening.

⚠ **`test.skip()` inside a test body does not skip the test — it passes it.** The module-level function DECLARES a new, nested, skipped test; the body then returns having asserted nothing, and the runner reports the outer test as an ordinary `ok` with no skip marker anywhere. Measured on node v22.23.1: a nested `# SKIP` line sitting above a plain `ok` for the test that was supposed to be skipped. Take the test context and call `t.skip()` on it — `test("…", (t) => { … t.skip(reason); return; })` — which reports correctly. A bare `return` has the same failure mode. This landed in `tests/env-file-write-is-atomic.test.mjs`, whose entire job is to stop a guard passing for the wrong reason.

⚠ **A mutation that breaks the parser tests the parser.** Proving a guard red means deleting the code it covers and watching it fail — but deleting one line out of a multi-line template literal produced a syntax error, both test files failed to load, and the run went red in a way indistinguishable from a working guard. Mutate whole statements, and assert the file still parses before believing the red. `node --check` is enough and it is one line.

⚠ **Do not assert that content survived when the question is whether anything was written.** A rewrite that produces identical bytes is invisible to a content comparison: measured 137/137/137 bytes across three SessionStarts on a branch that rewrote the whole file every time. The gate has to observe the WRITE, not the result — pin the mtime backwards with `utimesSync` and assert it did not move, or hard-link the file and check `nlink`. For the related question of whether a file was REPLACED rather than written through, use the hard link: `statSync().ino` is unreliable because ext4 hands a freed inode number straight back, which showed a constant inode across four consecutive replacements here.

The general form of all three: ask what would have to happen for this assertion to fail, and check that the test could actually observe it.

## Acceptance on a second, Linux host

`scripts/acceptance.sh` must pass on **two** hosts before a release: the development machine, and a Linux one. This is not redundancy — the two answer different questions.

Step 2b is the reason. The Grok CLI's `--sandbox read-only` is **not enforced on Windows**: the write lands and the CLI says nothing about it. So on Windows the read-only barrier rests entirely on tool removal and deny rules, and the sandbox half of it is never exercised. Only a host that actually *has* the enforcement mechanism can tell you whether that half still works. The step asserts a mechanism-dependent expectation on purpose — the write *must* land on Windows and *must* be refused where Landlock or Seatbelt is genuinely present — so if xAI ever ships Windows enforcement, the gate goes red and tells you the security documentation has gone stale.

⚠ **"A Linux host" is not the same thing as "a host with the mechanism", and choosing the wrong one costs you the very check you added the host for.** Landlock is a kernel configuration option. Raspberry Pi OS ships without it — measured 2026-08-09 on `6.12.96+rpt-rpi-2712`: `# CONFIG_SECURITY_LANDLOCK is not set`, LSM list `capability` alone. On such a kernel the CLI has nothing to enforce with, so 2b resolves `absent` and SKIPs: you still get the Linux coverage for path handling, line endings and process trees, but **not** the sandbox assertion. To exercise that, the second host must be macOS or a Landlock-enabled Linux. `ACCEPTANCE_FORCE_SANDBOX_MECHANISM=present` exercises the branch, never the mechanism, and says so in its own output.

⚠ **Run the unit suite through two different shells on the development machine, too — one host is not one environment.** `npm test` spawns a real `bash` for the `CLAUDE_ENV_FILE` guards, and on Windows bare `bash` resolves to MSYS2's or to the WSL alias depending on `PATH`. WSL's runs fine but cannot see `C:/Users/...`, so before `b4bf513` the same commit gave 409 pass / 1 skip through one shell and 407 pass / **2 fail** through the other. The guards now detect an unusable shell and skip with a reason, but the general point stands: a suite that has only ever run one way has only ever been tested one way. CI does cover Windows — six cells across Linux, Windows and macOS, see `.github/workflows/test.yml` — but it exercises one shell per runner, and not the one your terminal hands you. The shell is the variable, and it is a local one.

The second host also catches what one architecture hides: path handling, line endings, process-tree termination and the concurrency slot all behave differently there.

⚠ **And it catches what one host makes untestable.** The guard added in `tests/env-file-keeps-its-mode.test.mjs` cannot fail on Windows, where `chmod` moves only the read-only bit and every strategy reads back `666`. It SKIPs there rather than passing, because a green tick for a reason unrelated to what the test checks is worse than a visible gap. On Linux it runs, and the defect it guards was invisible until it did.

⚠ **Copy the WHOLE tree to the second host, not the parts you think the tests need.** Sending `plugins`, `tests` and `package.json` alone produced 19 failures that read convincingly as defects — manifest checks, documented-contract checks, plugin-name resolution — and every one of them was a file that had not been copied. The suite reaches the repository root. A partial copy fails in a way that looks like a finding, which is the expensive kind of wrong.

Running it away from the development machine:

```bash
# The plugin cache does not exist on a plain checkout, so point BRIDGE at the tree directly.
export CLAUDE_PLUGIN_DATA=/path/to/state    # or the run bills to a separate state root
                                            # and never appears in `usage`
BRIDGE=/abs/path/to/plugins/grok-build/scripts/grok-bridge.mjs bash scripts/acceptance.sh
```

⚠ **Locate `node` and `grok` on the filesystem, never through `PATH`.** On a Debian-family host a non-login shell returns early from `.bashrc`, so a node installed under `~/.local` is invisible to `which node`, to `bash -lc`, and to any process listing — all three report it missing while the binary is sitting there. Concluding "this host cannot run the bridge" from a `PATH` probe is a mistake that has been made here; prepend the real directories and re-check before believing an absence.

The acceptance suite is 14 checks and exits 0 only when every check **that ran** passed — which is not the same sentence, and the difference is the whole point of the SKIP note below. A skipped check touches neither counter, so a green run means "nothing failed", never "everything was tested". It makes real Grok CLI calls, so it spends allowance — budget for it rather than being surprised.

⚠ **A SKIP is not a pass.** Step 2b skips where the kernel has no sandbox mechanism, so a green run on such a host means thirteen checks passed and one was not testable. The summary line counts passes and failures only; read the SKIPs.

⚠ **Every release leaves the previous install behind, and tooling that assumes one copy will break on it.** Measured 2026-08-10 with a throwaway marketplace: `claude plugin update` creates a NEW version-named directory under `~/.claude/plugins/cache/<marketplace>/<plugin>/`, repoints `installed_plugins.json` at it, and **leaves the old directory in place with its files intact**. `claude plugin marketplace remove` does not clean the cache either. So the cache gains one tree per release, permanently.

Nothing is wrong with the installed plugin when this happens — Claude Code loads the path the registry names, and `check` reads the build it was actually loaded from. What breaks is anything that finds the bridge by *searching the cache and expecting exactly one hit*. Resolve through `installPath` in the registry instead; keep a count check only as the fallback for when the registry cannot answer.

`scripts/acceptance.sh` takes the FIRST glob match, so with two versions present it would grade the older one — it is saved only because step 0 now fails when the build under test disagrees with the working tree. That was luck, not design; if you ever weaken step 0, fix the glob first.

⚠ **Step 0 fails when the build under test is not this tree**, because acceptance targets the INSTALLED plugin by default and that goes stale the moment you edit anything. Run `scripts/deploy-local.sh` first. This is not hypothetical bookkeeping: before that check existed, a full green run gated an installed 0.3.2 whose read-only removal list carried four ids against the tree's fourteen, and nothing in the output said so.
