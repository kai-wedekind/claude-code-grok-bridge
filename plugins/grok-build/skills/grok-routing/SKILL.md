---
name: grok-routing
description: When to reach for Grok Build rather than doing the work in Claude Code — the routing tiers (manual, second-opinion, reach, offload-first, delegate-write), what each one covers, what it costs, and how to call it. Load this before offloading work, before asking for a second opinion, and before delegating anything to Grok — including when the user's CLAUDE.md names a tier without explaining it.
---

# When to reach for Grok Build

Installing this plugin gives Claude Code the **ability** to use Grok. It does not give it an
**occasion**. Eight slash commands sit there until somebody types one, and the only thing
that fires by itself is the `grok-delegate` agent's description — which covers being stuck
and wanting a second implementation pass, and nothing else.

That gap is deliberate: how much of your work should leave your machine is your decision,
not this plugin's. This skill is the menu; your `CLAUDE.md` picks a dish.

## Reading your own setting

Your project or user `CLAUDE.md` should carry one line naming a tier. If it does not, the
tier is **manual** — do not offload anything the user did not ask for.

If it names a tier you do not recognise, ask rather than guess. A wrong guess here spends
somebody's paid allowance.

## The tiers

Each is a superset of the one above it. Risk and reach grow together, and so does spend.

### `manual` — nothing automatic

Slash commands only: `/grok-build:review`, `/grok-build:critique`, `/grok-build:delegate`,
`/grok-build:runs`, `/grok-build:stop`, and the rest. Never route work to Grok on your own
initiative. This is the default and the right starting point.

### `second-opinion` — independent eyes on finished work

Send **completed** work out for review, critique or verification. Read-only, always.

The value here is not that Grok is better; it is that it is **not you**. It did not choose
the approach, did not write the test, and does not know which parts you were confident
about. That is the whole reason a second pass finds anything.

Good moments: after a non-trivial change and before declaring it done; when a fix touches a
path that is hard to test; when you have just written the test that proves your own fix.

⚠ **A verifier that only reads your summary is worthless.** Give it the diff and the
commits, tell it what you claim, and ask it to disagree. If it comes back agreeing with
everything, suspect the prompt before believing the verdict.

### `reach` — what Claude cannot do at all

Everything in `second-opinion`, plus:

- **X/Twitter.** Claude has no access; Grok does. Live search there is a research instrument
  in its own right, not merely offloading.
- **Keeping bulk out of your context.** A long log, a big document, a wide sweep across a
  repository: the gain is not the other model, it is that the content never enters your
  context window at all. Below roughly 2000–3000 tokens of input this loses — the call
  itself costs more than it saves. Read it yourself.

### `offload-first` — fire the read-only slices before you start

Everything above, plus: decompose the task first, send the read-only slices immediately,
and work locally while they run.

The discipline that makes this pay is per-**slice** judgement. "This task mutates a live
system" never exempts its research slices. Fire them, keep working, collect later.

⚠ Anything started in the background needs something watching it. A run that finishes with
nobody waiting produces a result that rots on disk. Use `--wait`, or `/grok-build:runs
<id> --wait`, or arrange your own poll — but decide before you start, not after.

### `delegate-write` — Grok may change files

Everything above, plus `--write`. Read this before switching it on:

- The read-only barrier is what this fork exists for. Turning it off is not a small step.
- **Never on a repository you do not trust.** Repository content goes into the prompt, and
  a language model does not reliably tell "text I was asked to review" from "instruction
  addressed to me". See `SECURITY.md`.
- Write-delegation needs a **mechanical gate**: pre-written tests, or a worktree plus diff
  review, or a deterministic check command. If you cannot name the gate before you start,
  do the work locally instead. "I will read the diff carefully" is not a gate.

## What it costs, and why you cannot see it by default

Every run spends the user's Grok allowance, whichever plan backs it. There is no quota
endpoint, so the only local record is this plugin's own ledger:

```
node <plugin>/scripts/grok-bridge.mjs usage --days 7
```

Read the **allowance period** line, not the rolling window — they differ, and the rolling
one reads higher.

Two things that will otherwise mislead you:

- Runs started **without** `CLAUDE_PLUGIN_DATA` land in a temp-derived state root that
  nothing else looks at — not `runs`, not the ledger, not the session-end cleanup. Claude
  Code sets that variable for the plugin; a bridge started by hand from a shell does not
  have it.
- `usage` against a state root that does not exist reports a perfectly ordinary `$0.00`
  with a warning above it. If you see that warning, the zero means "wrong path", not "no
  spend".

## Failure codes worth knowing

`no-deliverable` (ran, produced nothing), `schema-parse` (output present but unusable),
`quota-exhausted` and `not-authenticated` (retrying cannot help — the second is the one
people waste an hour debugging as a schema problem), `timeout`, `output-truncated`. The
full table with exit codes is in the plugin README.

## The one thing this skill cannot do for you

It cannot make itself load. A routing policy that lives only here never fires, because a
skill is only read when something names it. That is why the `CLAUDE.md` line matters and
why it must name the **trigger** — "before offloading work or asking for a second opinion,
load `grok-build:grok-routing`" — and not merely the preference. A preference nobody reaches is
indistinguishable from no preference at all.
