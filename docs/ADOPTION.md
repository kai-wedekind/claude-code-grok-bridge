# Adoption: making Claude Code actually use this

Installing the plugin gives Claude Code the **ability** to reach Grok. It does not give it
an **occasion**. This document is about the difference, because that difference is where
most of the value is won or quietly lost.

## What already happens on its own, and what never does

After `claude plugin install`, three surfaces exist:

| Surface | Fires when |
| --- | --- |
| Eight slash commands (`review`, `critique`, `delegate`, `runs`, `show`, `stop`, `check`, `import`) | you type one |
| The `grok-delegate` subagent | Claude reads its description and judges it applies — being stuck, wanting a second implementation or diagnosis pass, handing over a substantial coding task |
| Internal helper skills | the bridge runtime needs them |

That is the whole of it. **Nothing else happens by itself.** "Send long documents to Grok
so they stay out of my context", "always use Grok for X/Twitter", "fire the research
slices before starting" — none of those are anywhere in the plugin, and a freshly installed
Claude Code will never do them.

That is deliberate. How much of your work leaves your machine, and how much of a paid
allowance it spends, is not a decision a plugin should make for you.

## Where the policy goes

Two pieces, two homes, and the split matters more than it looks:

**Your `CLAUDE.md` carries the choice and the trigger.** Keep it to a few lines. This file
is read into every session and never refreshes mid-session, so anything long or version-
dependent parked here becomes a stale copy that nobody notices — and it costs context in
every conversation, forever.

**The `grok-build:grok-routing` skill carries the mechanics.** Skill bodies load fresh when
invoked, so they travel with the plugin: tier definitions, call forms, failure codes, cost
notes. Update the plugin and the guidance updates with it.

⚠ **The trigger is the part people get wrong.** A policy that lives only in the skill never
fires, because a skill is read only when something names it. So the `CLAUDE.md` line must
say *when to load it*, not merely which tier you like. "Read the campaign logs and tell me
what's wrong" names no skill; without a trigger sentence, the mechanics stay unread and the
work goes wherever the model's reflex sends it.

**Not memory.** Project memory is not reliably present at the moment of the decision, and
routing is a standing preference rather than a fact about a project. Use user-level
`CLAUDE.md` for "always", project-level for "in this repository".

## The line to paste

Pick one tier and drop this into `CLAUDE.md`:

```markdown
## Grok Build bridge
Routing: **second-opinion**   (manual | second-opinion | reach | offload-first | delegate-write)

Before offloading work, asking for a second opinion, or delegating anything to Grok:
load the skill `grok-build:grok-routing`. It defines the tier above and how to call it.
This file names only the choice — never the mechanics.
```

Five lines, one named trigger, no mechanics. That is the whole integration.

## The tiers, in one sentence each

| Tier | Grok is used for |
| --- | --- |
| `manual` | nothing automatic — slash commands only. **Default.** Start here. |
| `second-opinion` | reviewing, critiquing and verifying *finished* work. Read-only. |
| `reach` | + what Claude cannot do: X/Twitter, and reading bulk that would otherwise fill your context. |
| `offload-first` | + read-only slices fired proactively, before local work begins. |
| `delegate-write` | + `--write`, in a worktree, behind a mechanical gate. |

Full definitions, the reasoning, and the traps live in the skill. They are not repeated
here on purpose: two copies of the same rule drift, and the one you read is rarely the one
that was updated.

## Before you go past `second-opinion`

Three things that are cheap to read now and expensive to learn later:

- **Spend is real and mostly invisible.** Every run draws on your Grok plan's allowance; as of
  2026-08-01 no quota endpoint is published, so the only local record is
  `grok-bridge.mjs usage`. Read the
  *allowance period* line, not the rolling window.
- **Read-only is the actual barrier** — enforced by removing the writing tools and adding
  deny rules, not by `--sandbox`, which does nothing on Windows. See `SECURITY.md`.
- **Repository content is untrusted input.** It goes into the prompt, and a model does not
  reliably distinguish "text to review" from "instruction to follow". Never `--write` on a
  repository you did not write.

## Two operational surprises worth knowing up front

Both were found the hard way during a clean reinstall on 2026-08-01, against Claude Code
2.1.196, and neither is obvious:

- **`claude plugin uninstall` deletes the plugin's data directory** — the run records and
  the spend ledger — while leaving the cache directory in place. The asymmetry is exactly
  backwards: the irreplaceable part goes automatically, the re-installable part stays. The
  command says only `Successfully uninstalled plugin` and exits 0; the data directory is
  never mentioned. If the ledger matters to you, read it or copy it *before* you uninstall
  — that is the first command of a reinstall, so there is no second chance.
- **Runs started without `CLAUDE_PLUGIN_DATA`** land in a temp-derived state root that
  nothing else looks at — not `runs`, not the ledger, not the session-end cleanup that is
  supposed to stop background agents outliving their session. Claude Code sets the variable
  for the plugin; a bridge invoked by hand from a shell does not have it.
