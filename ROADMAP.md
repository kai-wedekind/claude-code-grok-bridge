# Roadmap

What this plugin is likely to grow next, and — just as usefully — what it is not going to grow. Nothing here is a commitment with a date on it. It is a maintained project with one maintainer, so treat the order as intent rather than a schedule.

The through-line, so the choices make sense: this fork exists to make a delegated run **trustworthy** — you can see what it cost, stop it and know it stopped, and tell an answer from a failure. Everything below is chosen because it serves that, and the "not planned" section is mostly things that would trade it for breadth.

## Next

**Isolation for write runs.** Today `--write` gives the agent your working tree, and the documentation says so plainly rather than pretending otherwise. That honesty is not the same as safety. The intent is for a write run to happen in a throwaway git worktree, so what comes back is a diff you look at before anything reaches the tree you care about — with the worktree owned by this plugin rather than delegated, because the CLI's own `--worktree` flag does nothing in headless mode. This is the single largest gap and the thing that would let write mode be *recommended* rather than merely documented.

**A read-only mode that cannot reach the network.** Read-only is a *write* barrier, and 0.3.3 widened it considerably: fourteen tools are now removed rather than four — the shell, the file editor, both MCP meta-tools, `write`, `monitor`, the four media generators, all three scheduler tools, and **`web_fetch`**. Several of those reach the network, so less of an outward path is left open.

What remains open is `web_search`, deliberately, because research offloads are half of what this is for. That is the right default and it is not the right *only* option — reviewing a repository you do not trust is exactly the case where you want the model unable to send anything outward, and `SECURITY.md` is explicit that the current mode does not give you that. The CLI already has `--disable-web-search`; this bridge does not pass it. It would be enforced the same way the write barrier is enforced, by removing the tool rather than by asking the model nicely, which is what makes it worth building rather than merely worth claiming. Prompted by the first question a reader asked after publication, which the documentation could not answer.

**Per-workspace defaults.** Model, reasoning effort and web search, set once for a project instead of repeated on every invocation. Small, and the one people would feel every day.

**Spend summaries.** The local ledger already records what every run reported. What it does not do is answer the questions people actually have — what did this week cost, which kinds of task are expensive, what is a typical run. That is presentation over data already on disk.

One honest caveat that comes with it: **the ledger cannot tell which pot paid.** A run reports its cost the same way whether a subscription allowance or purchased credit covered it, because the CLI does not say. While the allowance pays, the dollar total tracks the allowance percentage closely; once credits pay, it silently means something else. The fix is not to guess — it is for the report to say what it cannot know, and that will land with the summaries.

**Multimodal — image, video, vision, speech.** The `grok` binary exposes these, and a bridge that reaches less of the CLI than the CLI offers is delivering less than it could. Two halves worth naming because they cost differently: handing Grok an image to *look at* is an input problem and fits the read-only default as it stands, while *generating* an image or a video is write-shaped — the artifact lands on disk — and has to be reconciled with a mode whose whole point is that nothing is written. 0.3.3 settled the near half of that by removing the four generators from read-only outright, so the reconciliation is now a thing to design rather than a discrepancy to explain. Expect the input half first.

**Finishing the session env-file writer.** 0.3.3 replaced an append with a whole-file rewrite and then an atomic temp-and-rename, and two independent audits of that change on 2026-08-10 turned up more than the change itself fixed. Three items are queued rather than done, and they are listed here because each one is a property the *previous* implementation had for free and the current one has to earn back.

The largest is that **the write mostly does not need to happen at all**: SessionStart fires on resume and on compaction as well as at session start, and when all three values are unchanged the hook still performs three full-file replacements. Every hazard the atomic write exists to manage — the truncation window, the temp file, the permissions, the rename failure path, the lost-update window — is currently paid on every one of those to produce byte-identical content. A two-line early return removes most of the occasions; the rename then covers what is left. Naming the tension rather than leaving it to be spotted: the guard weakens the case for the rename by making it rarer, and the two compose rather than compete.

Then **line endings**: foreign lines written with CRLF come back as LF, so another tool's file is reformatted on every session start, on the platform where CRLF is normal. That contradicts this file's own argument for not touching content we do not own, and it predates the rewrite rather than arriving with it. And **the temp file**: it is named predictably, written without an exclusive flag, and orphaned outright if the host kills the hook between the write and the rename — leaving a file containing a session id in a directory the plugin does not own.

**And a question about the atomic write itself, which is the honest one to end on.** An independent review of the same problem argued for the opposite design: keep the plain in-place write, batch all the variables into a single pass, and skip the write entirely when nothing changed. Writing in place keeps the inode, so file mode and symlink identity survive by construction rather than needing a `chmod` and a `realpath` to carry them across a rename; the rename needs a Windows fallback which is the same truncating write it exists to avoid; and with a skip guard an unchanged event does not write at all, so the exposure stops scaling with session length. Measured against a working implementation of that shape: an unchanged SessionStart leaves the file's mtime untouched.

If that is right, this fork carries around sixty lines — retry ladder, mode carry-over, symlink resolution, fallback, warnings — that exist only to repair damage the rename causes. What decides it is a question nobody has answered in either direction: **whether anything actually reads `CLAUDE_ENV_FILE` during the window a SessionStart write is open.** The case for atomicity has always rested on Claude Code inlining that file into every `bash -c`, which is true, and on a reader landing mid-write, which has never been demonstrated. Until it is, the machinery is defensible as defence-in-depth and not as a measured need — and the comments should say which of those they mean.

## Later

Richer multi-session handling, once isolation has settled what a session is; named safety modes so a single choice replaces a flag combination; comparing two runs and accepting one, which only becomes worth building once write runs are safe enough that people use them for implementation; and an adversarial review mode that attacks a change rather than assessing it.

Also a **thin-controller mode**. Some bridges push nearly all reasoning to the worker and run the controller as cheaply as possible. That is not the default here — Claude stays in charge and delegation is a tool it reaches for — but it is a policy about where reasoning happens rather than a different architecture, so it is a flag and a branch rather than a rewrite. The cost is that every mode doubles what has to be tested, which is why it is here and not above.

## Not planned

**An MCP-server architecture.** A coherent design, and not this one. Adopting it would mean rewriting rather than growing, for no gain against the goals above. This is the only entry here that is a decision rather than an ordering — everything else that is missing from this document is missing because it has not been worked through yet, which is not the same thing.

## Fixing things

Bug fixes ship when they are ready. Features accumulate and go out as a version bump with a tag and release notes, so there is something to pin to and something to read.

**Security fixes are the exception and ship immediately**, out of band, without waiting for a release to be assembled.

If something here matters to you, or something not here matters more, open an issue — an argued case from somebody actually using it is worth more than this document's ordering.
