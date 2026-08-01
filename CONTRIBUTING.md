# Contributing

This is a personal fork of xAI's grok-build Claude Code plugin, maintained for
day-to-day use by Kai Wedekind ([@KaiWedekind](https://x.com/KaiWedekind)). Issues and
pull requests are welcome; there is no service-level promise attached to them.

For anything that is not a bug — a question, or telling me it was useful — 𝕏 is fine and
probably faster. Bugs belong in an issue, because they need the artifacts below, and
security reports belong in [SECURITY.md](SECURITY.md)'s private channel rather than
anywhere public.

## Reporting a bug

⚠ **Copy the job record out before you do anything else.** Finished records are
pruned to the newest 50 per workspace, so the evidence for your bug is deleted by
ordinary use, often within a day. Take both files:

```
<CLAUDE_PLUGIN_DATA>/state/<workspace>-<hash>/jobs/<run-id>.json
<CLAUDE_PLUGIN_DATA>/state/<workspace>-<hash>/jobs/<run-id>.log
```

`grok-bridge.mjs usage --json` names the state root it read, if you are not sure
which one you are on. The result is stored verbatim and is not redacted, so skim
both before attaching them.

The issue template asks for the rest. Two fields there are worth explaining rather
than leaving as boxes to fill: give the **exit code and the printed output both**,
even when they seem to agree, because a disagreement between them is itself a bug
here — a run can exit `0` having returned only its progress narration. And name
the **platform**, because the CLI's sandbox flag is not enforced on Windows,
executables need `PATHEXT` resolution there, and every system reports a dead
process differently; a defect that reproduces on one routinely does not exist on
another.

The `.log` is the only artifact that shows whether any tool call happened at all.

## Ground rules for changes

**A bug fix needs a regression test that fails without the fix.** Not a test that
passes afterwards — one you have watched fail first. Most of this codebase deals
with locks, process liveness and partial output, where it is easy to write a test
that would pass against the broken version too.

**`npm test` must be green on Linux, Windows and macOS.** A large part of the fork
exists because the platforms differ: the Grok CLI's sandbox flag is not enforced on
Windows, executables need `PATHEXT` resolution there, spawning through a shell causes
real damage, and each system reports a dead process differently. CI runs all three
across six cells: Linux on Node 18.18, 20 and 22; Windows on the oldest and newest of
those; macOS on the newest. The grid is uneven on purpose — a Windows runner minute bills
as two and a macOS minute as ten, so a full three-by-three matrix spent more than half its
budget on the platform least likely to break. Documentation-only changes skip CI entirely.

The macOS cell earned itself immediately, and the order is worth knowing: it was added
for an untested path (the `ps` fallback in `readProcessImageName`), and its very first
run then found a real defect — the image probe returned a non-matching name for a
process that had already exited, so a corpse was classified `image-mismatch` and never
settled. The cell came first and the discovery followed, not the other way round.

Note what that coverage is and is not. The unit suite genuinely spawns and kills real
processes, so the process layer is exercised on all three systems. Nothing in CI runs
the actual Grok CLI — the end-to-end acceptance script (`scripts/acceptance.sh`) has
been run on Windows, Linux and Raspberry Pi, and never on macOS.

**Keep the scope.** The bridge shells out to the real `grok` CLI and owns run
state through PID and log files. It is deliberately not a daemon, a broker, or a
queue server.

**Honest reporting is a contract, not a preference.** Exit code, printed text and
JSON payload must agree. If a run failed, nothing in the output may read as
success — partial output is kept, but labelled as partial. Several of the bugs
this fork fixed were exactly this failure: a truncated review presented as a
finished one.

## Running the tests

```bash
npm test
```

The suite uses a fake `grok` CLI fixture, so it needs no credentials and never
contacts the real service. `scripts/acceptance.sh` is the separate suite that
does drive the real CLI; it is the maintainer's manual gate before a release.

## Local development

Claude Code loads the plugin from its install cache, not from the working copy.
After editing, run:

```bash
scripts/deploy-local.sh
```

`scripts/deploy-local.sh --check` reports drift without copying.

Two preconditions, both of which cost a first-time contributor an hour otherwise:

- The plugin must already be **installed** — this script mirrors into that install and
  cannot create it. See "Local install" in the README. Running it on a machine with no
  plugin cache exits 1 and prints the two install commands.
- On Windows it needs a real `bash`. Git for Windows ships one in
  `C:\Program Files\Git\bin\bash.exe`, but adds only its `cmd\` directory to `PATH`, so
  `bash` is typically not resolvable from PowerShell. Invoke it by full path, or use the
  Git Bash shell.
