# Roadmap

What this plugin is likely to grow next, and — just as usefully — what it is not going to
grow. Nothing here is a commitment with a date on it. It is a maintained project with one
maintainer, so treat the order as intent rather than a schedule.

The through-line, so the choices make sense: this fork exists to make a delegated run
**trustworthy** — you can see what it cost, stop it and know it stopped, and tell an answer
from a failure. Everything below is chosen because it serves that, and the "not planned"
section is mostly things that would trade it for breadth.

## Next

**Isolation for write runs.** Today `--write` gives the agent your working tree, and the
documentation says so plainly rather than pretending otherwise. That honesty is not the same
as safety. The intent is for a write run to happen in a throwaway git worktree, so what comes
back is a diff you look at before anything reaches the tree you care about — with the
worktree owned by this plugin rather than delegated, because the CLI's own `--worktree` flag
does nothing in headless mode. This is the single largest gap and the thing that would let
write mode be *recommended* rather than merely documented.

**A read-only mode that cannot reach the network.** Read-only today is a *write* barrier: it
removes the shell, the file editor and the MCP meta-tools — several of which can reach the
network, so removing them closes those paths as well — while `web_search` is deliberately kept
open, because research offloads are half of what this is for.
That is the right default and it is not the right *only* option — reviewing a repository you
do not trust is exactly the case where you want the model unable to send anything outward, and
`SECURITY.md` is explicit that the current mode does not give you that. The CLI already has
`--disable-web-search`; this bridge does not pass it. It would be enforced the same way the
write barrier is enforced, by removing the tool rather than by asking the model nicely, which
is what makes it worth building rather than merely worth claiming. Prompted by the first
question a reader asked after publication, which the documentation could not answer.

**Per-workspace defaults.** Model, reasoning effort and web search, set once for a project
instead of repeated on every invocation. Small, and the one people would feel every day.

**Spend summaries.** The local ledger already records what every run reported. What it does
not do is answer the questions people actually have — what did this week cost, which kinds of
task are expensive, what is a typical run. That is presentation over data already on disk.

One honest caveat that comes with it, discovered by running out of allowance deliberately and
then paying with credits: **the ledger cannot tell which pot paid.** A run reports its cost
the same way whether a subscription allowance or purchased credit covered it, because the CLI
does not say. Before that transition the dollar total tracked the allowance percentage almost
exactly; afterwards it silently means something else. The fix is not to guess — it is for the
report to say what it cannot know, and that will land with the summaries.

**Multimodal — image, video, vision, speech.** The `grok` binary exposes these, and a bridge
that reaches less of the CLI than the CLI offers is delivering less than it could. Two halves
worth naming because they cost differently: handing Grok an image to *look at* is an input
problem and fits the read-only default as it stands, while *generating* an image or a video
is write-shaped — the artifact lands on disk — and has to be reconciled with a mode whose
whole point is that nothing is written. Expect the input half first.

## Later

Richer multi-session handling, once isolation has settled what a session is; named safety
modes so a single choice replaces a flag combination; comparing two runs and accepting one,
which only becomes worth building once write runs are safe enough that people use them for
implementation; and an adversarial review mode that attacks a change rather than assessing
it.

Also a **thin-controller mode**. Some bridges push nearly all reasoning to the worker and run
the controller as cheaply as possible. That is not the default here — Claude stays in charge
and delegation is a tool it reaches for — but it is a policy about where reasoning happens
rather than a different architecture, so it is a flag and a branch rather than a rewrite. The
cost is that every mode doubles what has to be tested, which is why it is here and not above.

## Not planned

**An MCP-server architecture.** A coherent design, and not this one. Adopting it would mean
rewriting rather than growing, for no gain against the goals above. This is the only entry
here that is a decision rather than an ordering — everything else that is missing from this
document is missing because it has not been worked through yet, which is not the same thing.

## Fixing things

Bug fixes ship when they are ready. Features accumulate and go out as a version bump with a
tag and release notes, so there is something to pin to and something to read.

**Security fixes are the exception and ship immediately**, out of band, without waiting for a
release to be assembled.

If something here matters to you, or something not here matters more, open an issue — an
argued case from somebody actually using it is worth more than this document's ordering.
