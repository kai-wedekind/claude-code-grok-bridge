# Changelog fragments

One file per change, written **when you make the change** — not at release time.

This is the `towncrier` / `changesets` / `reno` convention, kept deliberately small. There is nothing to install: `scripts/changelog.mjs` assembles and checks these with Node and no dependencies, which is the same rule the rest of this repository follows.

## Why

Release notes written from memory lose things. Not through carelessness — through the ordinary decay of a fortnight's work into "the stuff I did". 0.3.3 is the worked example: the notes were drafted at release time and left out the update notifier, which makes this plugin's first ever outbound network request, along with eight other user-visible changes. Two rounds of human review found them.

The filter that failed was *"was this code public before the last release?"*. That question is right for a **bug** — a defect introduced and fixed inside one cycle was never anyone's problem and does not belong in the notes — and useless for a **feature**, which is by definition not public before. So it cut the churn correctly and could not see the features at all.

A fragment is written while you still know which of the two you are looking at.

## How

Create `changelog.d/<slug>.<type>.md`:

```
changelog.d/subagent-strands.added.md
changelog.d/env-file-backslashes.fixed.md
changelog.d/import-command.removed.md
changelog.d/junction-containment.internal.md
```

Types: `added`, `changed`, `fixed`, `removed`, `security`, `internal`.

The body is the entry as it will read, in the same voice as the rest of the changelog: the problem first, because that is what tells someone whether it affects them.

## `internal` is the one that matters

`internal` means **deliberately not user-facing** — a bug this cycle introduced and fixed, a test, a maintainer script. It is written down and then dropped by the assembler.

That is the whole point. The alternative to a recorded `internal` decision is silence, and silence is indistinguishable from having forgotten. Every change leaves a fragment; the type is where you say what kind it was, once, while you still know.

## At release

```bash
node scripts/changelog.mjs check
node scripts/changelog.mjs assemble --version 0.4.0
```

`assemble` writes the section into `CHANGELOG.md` and deletes the fragments it consumed. Edit the prose freely afterwards — fragments are a capture mechanism, not a format to obey.

`scripts/check-changelog-covers-roadmap.mjs` remains as the backstop, for anything that reached the roadmap without leaving a fragment.
