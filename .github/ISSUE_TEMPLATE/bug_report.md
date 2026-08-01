---
name: Bug report
about: Something the bridge did that it should not have, or did not do that it should
title: ''
labels: ''
assignees: ''
---

<!--
⚠ COPY THE JOB RECORD OUT FIRST, BEFORE ANYTHING ELSE.

Finished job records are pruned to the newest 50 per workspace, so the evidence for
your bug is deleted by ordinary use — often within a day. It has happened here that
the only record of a defect was gone before anyone came back to look at it.

Both files, from the state root:

  <CLAUDE_PLUGIN_DATA>/state/<workspace>-<hash>/jobs/<run-id>.json
  <CLAUDE_PLUGIN_DATA>/state/<workspace>-<hash>/jobs/<run-id>.log

`grok-bridge.mjs usage --json` prints which state root it read, if you are unsure.
Skim both for anything private before attaching — the result is stored verbatim and
is not redacted.
-->

## What happened

## What you expected instead

## The run

- **Run id:**
- **Command or slash command:** (e.g. `/grok-build:review --wait`, or the full `run` call)
- **Read-only or `--write`:**

## Exit code *and* what was printed

<!--
Please give both, even when they seem to agree. A disagreement between them is a
bug in itself here: a run can exit 0 having returned only its progress narration
instead of an answer, and the exit code alone will not show that.
-->

- **Exit code:**
- **Printed output:**
- **`failureCode`,** if any:

## Environment

- **OS and version:**
- **`node --version`:**
- **`grok --version`:**
- **Plugin version:** (`claude plugin list`)
- **`CLAUDE_PLUGIN_DATA` set?** yes / no

<!--
Platform matters more here than in most projects: the CLI's sandbox flag is not
enforced on Windows, executables need PATHEXT resolution there, and every OS
reports a dead process differently. A bug that reproduces on one system routinely
does not exist on another.
-->

## Attached

- [ ] `<run-id>.json`
- [ ] `<run-id>.log` — the only artifact showing whether any tool call happened
