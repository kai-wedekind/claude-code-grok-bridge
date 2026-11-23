# Claude Code ↔ Grok Build Bridge

[![tests](https://img.shields.io/github/actions/workflow/status/kai-wedekind/claude-code-grok-bridge/test.yml?branch=main&label=tests)](https://github.com/kai-wedekind/claude-code-grok-bridge/actions/workflows/test.yml) [![release](https://img.shields.io/github/v/release/kai-wedekind/claude-code-grok-bridge)](https://github.com/kai-wedekind/claude-code-grok-bridge/releases/latest) [![license](https://img.shields.io/github/license/kai-wedekind/claude-code-grok-bridge)](LICENSE) [![last commit](https://img.shields.io/github/last-commit/kai-wedekind/claude-code-grok-bridge)](https://github.com/kai-wedekind/claude-code-grok-bridge/commits/main)

**Give Claude Code a second model to hand work to.** A diff to review, a problem you are stuck on, a job long enough that you would rather not sit and watch it — Grok takes it and answers back into the session you are already working in. A marketplace plugin that shells out to the real `grok` CLI; no broker, no service in between.

It bills to your Grok account rather than to Claude quota. If you already pay for a plan that includes Grok — an X Premium subscription, say, though which plans include what is xAI's to define, so check their current terms — and you spend your working day in Claude Code, chances are you are nowhere near using what you are already paying for. This puts it to work without changing where you work.

The rest of the effort here went into making a delegated run trustworthy: you can see what it cost, stop it and know it stopped, and tell the difference between an answer and a failure.

**What you get:**

- **A genuinely independent second opinion.** The point is not another pass by the model you are already talking to. It is a different one, with its own blind spots, reading your diff or your design and disagreeing where it disagrees.
- **Reach into 𝕏, which Claude Code cannot.** x.com is closed to it; Grok has that access natively. A post URL or a research question — what shipped, what people are hitting, how they worked around it — gets answered without leaving your session.
- **Work that outlives the request.** Send a long job to the background and carry on. It can be listed, inspected while it runs, and picked up afterwards, from any session.
- **Stop that tells you whether it stopped.** Cancelling terminates the process tree and checks the result against the operating system rather than against a message. When the kill lands, the run is `cancelled` and done. When it does not, the run is still marked `cancelled` — but it says so, in `errorMessage`: *"Stop claimed but process may still be running (kill not delivered)."* Read that field before assuming an agent has stopped spending.
- **You can see what it costs.** Every run's reported spend is kept locally, by day and by workspace. There is no quota endpoint to ask, so this is the only view you have — and it separates runs that cost *nothing* from runs whose cost is *unknown*, rather than scoring both as zero and flattering the total.
- **A result, or a reason there is none.** Success means output arrived, failure names which kind of failure it was, and partial output is kept and labelled as partial. The exit code, the printed text and the JSON payload are not allowed to disagree.
- **Read-only by default, and the default is real.** The writing tools are removed rather than discouraged, which holds on Windows too, where the CLI's own sandbox flag is not enforced. It is a write barrier, not a network barrier — web search stays available, and `SECURITY.md` says what that does and does not protect. Full write access is one flag away when you want it.
- **Built for repeat use, not one-shot demos.** Conversations continue across separate calls instead of restarting cold; structured output comes back as parsed JSON and fails loudly rather than handing you prose that will not parse; and you can fire as many runs as you like without counting what is already in flight.
- **Nothing installed from a registry.** No dependencies, no lockfile. `git clone` plus Node is the entire supply chain, and you can read all of it.
- ⚠ Installing it does **not** make Claude Code use it. See [Making Claude Code actually use it](#making-claude-code-actually-use-it) — that gap is deliberate.

⚠ **Windows and Linux are used in earnest. macOS is not.** All 671 unit tests run on all three in CI, including tests that spawn and kill real processes — but the end-to-end suite that drives the actual `grok` CLI has only ever run on Windows, on Linux and on a Raspberry Pi, because there is no Mac here to run it on. macOS is not deliberately unsupported and there is no known reason it would fail; it is simply unverified in real use, so stable operation there is not something this project can promise. If you run it on a Mac and something breaks, that is a useful bug report.

**Requires** Node ≥ 18.18 and a logged-in `grok` CLI, both on the persistent PATH. **Start at** [Install](#install), or the [FAQ](#faq) if you would rather have the obvious questions answered first — whether your code leaves the machine, whether this collides with xAI's own plugin, which plan you need. **Before pointing it at code you did not write,** read [SECURITY.md](SECURITY.md) — particularly what read-only does and does not protect.

---

## Project status

⚠ **Development continues on the author's own schedule, with no promise of support.** The author objects to Anthropic's decision to [watermark Claude's output](https://support.claude.com/en/articles/16266773-how-claude-marks-ai-generated-content); the reasoning is set out under [On Claude's output watermark](#on-claudes-output-watermark) below.

**What it doesn't mean:** The code works and is tested: the unit suite runs on Windows and Linux in CI, and an end-to-end suite that drives the real `grok` CLI is green on Windows and on a Raspberry Pi. `SECURITY.md` describes what read-only does and does not protect, and names the residuals it does not close rather than glossing them. Nothing here is being withdrawn.

It also does not mean the fork has stopped being worth having. Every defect listed under [About this fork](#about-this-fork) is one the original still has, and several of them are the kind that fail quietly: a run that reported success having produced nothing, a stop that believed a message instead of asking the operating system, a session hook that grew the host's shell environment until `bash` began failing in a way that pointed at bash rather than at this plugin, a bridge that silently did nothing when installed behind a symlink, and review context that followed a symlink out of the repository and inlined whatever it found. On top of that, context collection is hardened against a reviewed repository getting a program run through `git` before the agent is even launched — a class the original does not address at all, closed here across five distinct mechanisms, each demonstrated and each gated by a test.

The capability gap runs the same way. Per-run spend accounting against an allowance with no quota endpoint, background runs that outlive the call that started them, named threads that continue a conversation across invocations, schema-constrained structured output that fails loudly rather than returning unparseable prose, machine-wide self-scaling concurrency, failure classification where the exit code, the printed text and the JSON payload are not permitted to disagree, and visibility into what Grok's subagents actually did. `CHANGELOG.md` records each change with the reasoning and, where it matters, the measurement behind it.

**What it does mean:** Expect no fixed release schedule, no guaranteed adaptation as either the Grok CLI or Claude Code moves underneath it, and no reliable response to issues or pull requests. Both sides of this bridge are moving targets, and the parts most likely to go stale first are the ones pinned to the CLI's own surface — the tool-removal list and the reasoning-effort levels, both of which have already had to be corrected once for exactly that reason.

**If you need more than that**, fork it. It is Apache-2.0, there is no CLA, and nothing needs asking. xAI's own [grok-build plugin](https://github.com/xai-org/grok-build-plugin-cc) is the alternative if you would rather be on something a vendor maintains; this fork's changes and the reasoning behind each are in `CHANGELOG.md`, so a maintainer can see what to keep and what to drop.

---

## About this fork

This is a **modified fork** of xAI's grok-build Claude Code plugin (Apache-2.0). It is maintained by Kai Wedekind ([@KaiWedekind](https://x.com/KaiWedekind)) and is **not** an official xAI release. It is not an Anthropic product either, and carries no endorsement from, or affiliation with, either company. Grok, Grok Build, SuperGrok, Claude Code and X are named throughout only to say what this software talks to and what it spends — see `NOTICE` for the trademark attributions. It comes with no warranty; the Apache License 2.0 in `LICENSE` governs that, in sections 7 and 8.

It exists to make the bridge dependable enough to leave running: a run either produces something or says why it did not, agents can be stopped and their spend accounted for, and the whole thing behaves the same on Windows as it does anywhere else.

**It does not take capabilities away.** Grok can still write code, run commands and edit files here — that is `--write`, and it works. What changed is which mode is the *default*, and whether the guarantees the original made were actually true on every platform.

Substantive changes relative to the upstream baseline, [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc) at `5a9f924`. Each is written as the problem first, because that is what tells you whether it affects you. The fork's development history was condensed into a single commit for publication, so this list — together with `CHANGELOG.md` — *is* the record of what changed; it is not a summary of commits you can go and read here.

- **A run could report success having done nothing.** Read-only work was routed through interactive plan mode, whose "present a plan and wait" branch dead-ends when there is nobody to approve it — so the run ended, exited `0`, and returned a plan instead of an answer. Plan mode is no longer used as a barrier; deliverables are detected from the CLI's own JSON, and the exit code now means something: `0` only with output, `2` without, plus a `failureCode` saying which kind of nothing you got.
- **Read-only rested on something not enforced on Windows.** The original relied on the CLI's `--sandbox read-only`. xAI documents enforcement through Landlock on Linux and Seatbelt on macOS and names no Windows mechanism, so there the flag is passed and the command line shows a protection that is not in force. Measured 2026-08-08 against `grok 1.0.0`, with no plugin involved: a direct run with `--sandbox read-only` created the file anyway and exited `0`. **The CLI says nothing while it happens** — stderr was empty. The warning you may have seen about this comes from the bridge, not from xAI. Confinement now happens at the tool layer, by removing the writing tools and adding deny rules for `Bash`/`Write`/`Edit`/`MCPTool`, which holds everywhere; the kernel sandbox is an extra layer where the OS supports it, not the load-bearing one. On a Linux kernel without Landlock a current CLI does not continue: grok 1.0.70, measured 2026-10-24, exits 1 before any model call with `could not apply the 'read-only' sandbox profile` and refuses to start, and the public 1.0.45 source already does. The bridge therefore passes `--sandbox off` on that kernel only — explicitly, so a profile in the user's own Grok config or `GROK_SANDBOX` cannot re-trigger the refusal; a managed requirement still outranks the CLI flag (cli-1.0.45 `crates/codegen/xai-grok-shell/src/agent/config.rs:632-643`, precedence requirement > CLI > env > config) and can force a profile — and reports that the sandbox was not requested. An unanswered probe still passes `read-only`. Windows is unchanged: the flag is still passed and still not enforced. **`--write` unlocks full write access**: every tool and `--always-approve`, with no sandbox requested and nothing that keeps writes inside the directory you point `--cwd` at. `--cwd` sets the working directory; it bounds neither what a write run can change nor what a read-only, review, critique or connector run can read — any file the account can read, including `~/.ssh`, `~/.claude` and `~/.grok`. See `SECURITY.md` for what each mode does and does not protect.
- **Killing a run did not reliably kill the agent.** Stopping now terminates the real process tree and confirms it, rather than marking a record cancelled and leaving a process behind; a job whose processes are gone is reclaimed instead of sitting at "running" forever. Crash recovery is covered by the acceptance suite, not just by unit tests.
- **Spend was invisible.** Every run draws on a paid allowance with no quota endpoint to ask. The bridge now keeps a local ledger of what each run reported — `usage` reads it, names which state root it read, and counts runs whose cost is *unknown* separately from runs that cost nothing.
- **Long-running work had nowhere to live.** `--background` plus tracked run records, so a run survives the call that started it and can be listed, inspected and stopped afterwards.
- **Every invocation started a new conversation.** `--thread <name>` continues a per-workspace Grok conversation across separate bridge calls, so iterative work does not mean re-sending context.
- **Results were prose only.** `--json-schema` constrains the output and hands back a parsed `structured` payload; output that does not parse fails the run instead of quietly arriving as text.
- **Concurrency was a fixed bound of three, and overflow failed the run.** The bound is now self-scaling and machine-wide via a file-based semaphore; at the limit runs queue and then start rather than being rejected, so a caller never has to count other agents before offloading.
- **Windows process handling went through a shell.** Executables are resolved via `PATHEXT` and spawned directly — no ShellExecute dialog, no MSYS path mangling — and long prompts are handed over in a file rather than on `argv`, which used to hit `ENAMETOOLONG`.
- **Review context followed symlinks out of the repository.** A link in the working tree had its target read and inlined into what was sent to the model. Symlinks are now detected with `lstat` and named without being opened.

Identity metadata in this tree names Kai Wedekind as owner/author; the plugin functional name remains `grok-build`. Upstream copyright stays in `NOTICE` / `LICENSE`.

---

[Grok Build](https://x.ai) in Claude Code for review, critique and delegation. Run status, results and stop are owned by the plugin through PID and log files; there is no app-server broker.

---

## On Claude's output watermark

Since August 2026, text produced by new Claude models carries a statistical watermark applied [at the model level](https://www.anthropic.com/news/claude-text-watermark), across the API, Claude Code and every other surface, worldwide. It is applied to every customer. Anthropic's documentation identifies no setting, no term and no arrangement by which anyone may decline it.

The stated justification is compliance with the EU AI Act. An obligation to mark generated content is a floor, not a specification, and it left Anthropic wide latitude in how to meet it. That latitude was used in one direction at every point. The mark is woven into the text itself rather than attached as detachable provenance metadata — Anthropic uses exactly that lighter mechanism for generated files, so the less invasive option was not merely available in principle but already implemented alongside. It is applied at the model level rather than per surface, so it reaches the API and developer tooling and not only the consumer product. It is applied worldwide rather than where the obligation binds. It reaches text the customer only had proofread, translated or summarised — material that was theirs before Anthropic was involved. And it is applied with no means of refusal at all. At each of those decisions a narrower reading of the requirement was available, and the broader one was taken. The regulator did not ask for this shape; Anthropic chose it, and the only forward commitment offered is that they "will continue to evaluate different approaches."

The material being marked is the customer's own work — source code, prose, documents drafted, translated or summarised on their instruction, in a product they pay for. That output now carries a mark which was not disclosed at the time of purchase, was not consented to, cannot be declined, and cannot be removed. A term of the service was altered unilaterally and to the vendor's advantage after payment.

**This decision is rejected here without qualification.** Marking a paying customer's own output is not a compliance detail. It is a supplier attaching a permanent, unremovable claim to work that the customer commissioned, paid for, and owns — and doing so undisclosed at the time of sale, unconsented, and after payment.

---

## Requirements

- Node.js `>= 18.18` — **on the persistent PATH**, not merely in the shell you install from. The session hooks invoke a bare `node`; where it is missing they fail silently and `GROK_CC_SESSION_ID` is never set. A portable, no-admin install is enough (unpack the Windows zip or the Linux tarball and add its directory to the user PATH).
- Grok Build CLI (`grok`) on `PATH`, or set `GROK_BINARY`. Official documentation, including how to install it: https://docs.x.ai/build/overview
- **Something for the CLI to bill against.** The bridge does not handle billing or authentication at all — it launches the CLI and reports what the CLI reports. So whatever makes `grok` work for you interactively will work here: a signed-in session, or `XAI_API_KEY` in the environment. Which plans and credit arrangements exist, and how they interact, is xAI's to define and change; check their current terms rather than trusting a list written here. What is worth knowing on this side is that **every run costs something**, that the bridge cannot see your remaining balance, and that the local ledger is therefore the only spend record you get.
- A logged-in Grok CLI session — verify with `grok models`, and read what it prints rather than trusting its exit code. On the first call after the access token expires, that command can exit `0` while stating that you are *not* authenticated: it reads its auth state before the in-flight token refresh completes. Measured twice on 2026-07-31 against grok 0.2.117: the refresh took 373 ms and 441 ms, and about 690 ms passed before the model catalog was usable. `/grok-build:check` accounts for this and will not report `ready` in that state.
- There are **no npm dependencies**. Nothing is installed from a registry, and there is no lockfile — `git clone` plus Node is the whole supply chain.
- **Platform coverage is uneven, and the two halves are worth separating.** *Unit tests:* the full suite runs in CI on all three operating systems — Linux across Node 18.18, 20 and 22, Windows on the oldest and newest of those, macOS on the newest. A good part of that suite spawns and kills real processes rather than mocking them, so the platform-specific process handling genuinely runs on each. *End to end against the real `grok` CLI:* a fourteen-gate acceptance suite covering the write barrier, structured output, thread continuity, concurrency, crash recovery and orphan cleanup — run on Windows, on Linux and on a Raspberry Pi (aarch64), and **never on macOS**, for want of the hardware. One of those gates can SKIP rather than pass: the control that tests the CLI's own sandbox skips when it cannot tell whether the kernel offers one, and a SKIP is not a pass of that assertion. On an unknown POSIX host that skip happens only when the CLI ran; a CLI that exits non-zero with empty stdout is graded FAIL ("did not run"). Where the probe says the mechanism is absent, that control expects the CLI to refuse to start, which is the documented fail-closed behaviour of current CLIs, not a skip. So macOS has the code exercised but not the product; expect it to work, do not expect it to be proven.

## Install

### The short way: ask Claude Code to do it

You are going to use this *through* Claude Code, so let it do the installing. Paste this into a session:

```text
Install the Claude Code ↔ Grok bridge for me:
clone https://github.com/kai-wedekind/claude-code-grok-bridge, register the clone as a
local marketplace, install the plugin grok-build from it, then run npm test and
/grok-build:check and tell me what both said. Stop and ask me if anything fails —
do not work around it.
```

It needs `git`, `node` (≥ 18.18) and the `grok` CLI on PATH; if one is missing it will say so. The last sentence matters: an installation that quietly routes around a problem is how you end up with a plugin that loads but does not work.

The long way is below, and it is worth reading once even if you took the short one — steps 3 and the two warnings are things the short way cannot check for you.

### 1. Get the code

```bash
gh repo clone kai-wedekind/claude-code-grok-bridge
cd claude-code-grok-bridge
```

Or without the GitHub CLI: `git clone https://github.com/kai-wedekind/claude-code-grok-bridge.git`

### 2. Register it as a local marketplace and install

**Unix / macOS** — from the repository root (the path must be absolute):

```bash
claude plugin marketplace add "$(pwd)"
# example: claude plugin marketplace add /absolute/path/to/claude-code-grok-bridge

claude plugin install grok-build@claude-code-grok-bridge
```

**Windows (PowerShell):**

```powershell
claude plugin marketplace add (Get-Location).Path
# example: claude plugin marketplace add C:\src\claude-code-grok-bridge

claude plugin install grok-build@claude-code-grok-bridge
```

Or, when Claude Code is already open, use `/plugin`, add the local marketplace path, then install `grok-build@claude-code-grok-bridge`.

> **The marketplace id is deliberately not upstream's.** It matches this repository rather than reusing `xai-grok-build`, so the official xAI plugin and this fork can be installed side by side. That matters more than it sounds: measured on a clean machine, 2026-07-31, Claude Code 2.1.196 accepted a second marketplace under an id it already knew **without any warning** and exited 0, after which the installed plugin failed to load and pointed at whichever path was registered last — and removing the duplicate marketplace uninstalled the plugin along with it.

### Staying up to date

*(Taking a newer **release**. For mirroring your own edits into the installed copy, see [Updating an existing install](#updating-an-existing-install) below — different job, `deploy-local.sh`.)*

**From 0.3.3 the plugin tells you when a newer release exists** — one line at session start, and a `Version:` line in `check`. It asks GitHub's public releases endpoint and nothing else; it never downloads or installs anything, and it stays silent rather than claiming you are current when the check has not run. Opt out with `GROK_CC_UPDATE_CHECK=0`. The details, including what it does when the check fails, are under [`/grok-build:check`](#grok-buildcheck).

**Being told is not being updated**, and the install above adds a step people miss: **the marketplace is your clone**, so refreshing it re-reads a directory rather than fetching anything. Updating therefore starts with git:

```bash
git -C /path/to/claude-code-grok-bridge pull
claude plugin marketplace update claude-code-grok-bridge
claude plugin update grok-build@claude-code-grok-bridge
```

⚠ **Skip the first line and the other two still succeed — and leave you on the old build.** That is the whole trap: the commands report success because the marketplace faithfully re-read a clone nobody had updated.

Then reload. Restarting Claude Code is the dependable way; `/reload-plugins` also exists. Confirm what you are actually running with `claude plugin list`, and read [CHANGELOG.md](CHANGELOG.md) or the [releases](https://github.com/kai-wedekind/claude-code-grok-bridge/releases) for what changed.

> Claude Code does have an auto-update path for marketplaces, but it is off by default for local and third-party sources — which is what the install above creates. So assume updating is yours to do — the notice tells you, it does not act for you.
>
> **0.3.2 is worth taking promptly if you are still below it.** It repairs a defect that degraded the host's shell rather than this plugin, so an affected user would have had no reason to suspect the bridge at all.

### 3. Verify the install

```bash
claude plugin list            # expect: grok-build@claude-code-grok-bridge — Status: enabled
claude plugin details grok-build
```

`details` should report 7 commands, 3 skills, 1 agent, and 2 hooks (`SessionStart`, `SessionEnd`). Then, inside Claude Code:

```text
/grok-build:check
```

Ready means Node is available, `grok` is available, and `grok models` both succeeded **and** did not deny the session. A first check always reports `update: unknown` and then `This is not an all-clear.`; that is the update cache, and `Status: ready` above it is the answer. If `check` reports the CLI missing, install it from https://docs.x.ai/build/overview and set `GROK_BINARY` if it is not on `PATH`:

```powershell
$env:GROK_BINARY = "C:\path\to\grok.exe"
# or a Node entry script: $env:GROK_BINARY = "C:\path\to\grok.mjs"
```

### Updating an existing install

Claude Code loads the plugin from its cache directory, not from this working copy, so edits here take effect only once they are mirrored across:

```bash
scripts/deploy-local.sh           # sync working copy → installed plugin
scripts/deploy-local.sh --check   # report drift and exit 1, for a pre-commit gate
```

This is a **sync** tool and not an installer: it needs the directory that step 2 creates and exits 1 with the install commands if it is missing. It also needs `node` on `PATH`, because the install path carries the plugin version and that is read from the manifest rather than hardcoded. On Windows it needs a real `bash` — Git for Windows puts one in `C:\Program Files\Git\bin`, which is not on `PATH` by default.

> **`claude plugin marketplace remove` does not delete the cache, and neither does a version bump.** Measured on two machines against Claude Code 2.1.196: after a rename or a bump, `~/.claude/plugins/cache` holds **both** directories, and the old one still contains the previous build. Nothing loads it — but `scripts/acceptance.sh` finds the bridge by globbing that cache and takes the first hit. That is worse than a coin toss: the glob sorts lexicographically, so `0.2.0` comes before `0.3.0` and the **stale** build wins reliably, for as long as the major number stays the same. After any rename or bump, delete the old directory and confirm the glob resolves to exactly one path.
>
> **`claude plugin uninstall` DOES delete the plugin's data directory — and that asymmetry is exactly backwards.** It takes the run records and the local spend ledger with it, silently, while leaving the re-installable cache in place: the irreplaceable part goes automatically, the replaceable part stays. The command prints `Successfully uninstalled plugin`, exits 0, and does not mention the data directory at all. **So read `usage` — or copy the state directory — before you uninstall.** That is the very first command of a reinstall, so there is no later moment at which to do it.
>
> Isolated against Claude Code 2.1.196: the directory `~/.claude/plugins/data/<marketplace-id>` was populated immediately before `claude plugin uninstall` and gone immediately after, with no command in between; `marketplace remove` was then run on its own and left the data directory untouched.

## Making Claude Code actually use it

Installing the plugin gives Claude Code the **ability** to reach Grok. It does not give it an **occasion**. The slash commands below wait until you type one, and the only thing that fires on its own is the `grok-delegate` subagent's description — being stuck, wanting a second implementation pass, handing over a substantial coding task. Everything else people expect ("keep long documents out of my context", "always use Grok for X/Twitter", "research first, then work") happens only if you say so.

That is a deliberate gap: how much of your work leaves your machine, and how much of a paid allowance it spends, is not a plugin's decision.

So there are two ways to run this, and both are legitimate end states.

**Manual only.** Slash commands are opt-in: type one when you want Grok. They do not fire on their own. The shipped `grok-delegate` agent can still be selected when Claude judges the main thread stuck, and that run spends. If you want none of that, put one line in `CLAUDE.md` telling Claude never to select it unless you ask. If slash commands plus that one constraint are all you want, you are finished — the rest of this section is optional.

**Or tell Claude Code when to reach for it.** A few lines in your `CLAUDE.md` turn "I could delegate this" into something that happens without you asking each time: send long documents to Grok instead of your context, always use it for 𝕏, get a second opinion before you commit. You decide which of those, and how far it goes.

**[docs/ADOPTION.md](docs/ADOPTION.md)** is the guide for the second path. It sketches five routing tiers — `manual`, `second-opinion`, `reach`, `offload-first`, `delegate-write` — and gives you a five-line block to paste into `CLAUDE.md`, with the definitions in the shipped `grok-build:grok-routing` skill so they travel with the plugin rather than rotting in a copy.

⚠ **Those tiers are an example, not a contract.** They exist so you have something that works without designing a policy first. Edit the skill, write your own tier, name different triggers, or ignore the whole scheme and put one sentence in your `CLAUDE.md` — the plugin does not read the tiers and does not care which you picked. It is your machine, your allowance, and your call how much of either this thing gets.

## FAQ

**Does my code leave my machine?** Yes. Every task is handed to the real `grok` binary, which sends it to the Grok service — prompts, file contents the agent reads, and its output. Nothing in this plugin changes that and no local setting prevents it. Separately, the CLI has a telemetry and trace-upload channel of its own that this plugin does not touch; [SECURITY.md](SECURITY.md) lists the switches, verified against the installed binary.

**Do I have to uninstall xAI's official plugin first?** No. This registers under a different marketplace id (`claude-code-grok-bridge`, not `xai-grok-build`) precisely so the two can sit side by side. Installing both under the same id fails in a confusing way, which is why the ids differ.

**Which Grok plan do I need?** Whatever makes `grok` work for you interactively will work here — the bridge does not handle billing or authentication at all, it launches the CLI and reports what the CLI reports. Which plans and credit arrangements exist is xAI's to define and change, so check their current terms rather than a list written here. What is worth knowing on this side: every run costs something, the bridge cannot see your remaining balance, and the local ledger is therefore the only spend record you get.

**I installed it and Claude Code never uses it. Is it broken?** No, that gap is deliberate. Installing a plugin makes commands available; it does not teach the model when to reach for them. See [Making Claude Code actually use it](#making-claude-code-actually-use-it) — a few lines in your `CLAUDE.md` is the whole fix.

**Is it safe to point at a repository I did not write?** Read-only is the default and is enforced by removing the writing tools, so the agent cannot change your files. But read-only protects *integrity*, not *confidentiality*: the reading tools and web search are still there, so hostile text in a repository can influence what the model does with what it read. `SECURITY.md` says exactly what each mode does and does not protect. Do not pass `--write` on a repository you do not trust.

**Does it work on macOS?** The unit suite runs there in CI, including tests that spawn and kill real processes. The end-to-end suite against the real `grok` CLI has never run on macOS, for want of the hardware. So the code is exercised and the product is not proven — expect it to work, do not expect it to be verified, and a bug report from a Mac is genuinely useful.

**What happens when the Grok allowance runs out mid-run?** The run fails with `failureCode: quota-exhausted`, and the surfaces you actually read say so in words: the output opens by naming the refusal, and `runs` and `show` summarise it the same way, instead of leading with the CLI's error envelope. The tokens the run had already spent before the refusal are still booked to the ledger — a refused run is not a free one. Whether retrying helps depends on the account: an allowance has to reset, credit can be topped up.

**Why is the history a single commit?** The fork's development history was condensed for publication. The upstream baseline is named in `NOTICE` and resolves in xAI's repository, so the exact set of changes is derivable by diffing this tree against it — and `CHANGELOG.md` says what changed and why.

## Commands

Slash-command behaviour details live in `plugins/grok-build/commands/*.md`. This section is the public contract.

### `/grok-build:check`

Probe Node + Grok CLI availability and authentication. Also reaps orphaned runs whose tracked processes are gone.

Two optional flags, both off by default because both cost something: `--verify-tools` asks the CLI whether it still recognises every id in the read-only removal list (it has to start a real session), and `--fetch-update` asks GitHub for the latest release now rather than reporting the cached answer.

**Update notification.** From 0.3.3 onward the plugin tells you when a newer release exists. The SessionEnd hook asks GitHub's public releases endpoint and caches the answer — at most once every six hours after a success, and on a one-hour-doubling-to-one-day backoff after a failure; the next session start prints one line if you are behind. It never downloads or installs anything, and — the part that matters — **if the check failed or has never run, it says nothing rather than telling you that you are up to date.** `check` reports the same state in a `Version:` line that is never omitted, `unknown` included.

Turn it off with `GROK_CC_UPDATE_CHECK=0`. What is sent, when, and what is done with the answer is documented in [SECURITY.md](SECURITY.md) — it is the only outbound request this plugin makes on its own.

⚠ This cannot reach anyone already on 0.3.0, 0.3.1 or 0.3.2, because the notifier ships *inside* a later version. That is precisely the population it exists for, and the gap is unavoidable.

### `/grok-build:review`

Read-only review of local git state (write barrier, not plan mode):

```text
/grok-build:review --wait
/grok-build:review --background --scope working-tree
/grok-build:review --base main
/grok-build:review --wait --model <model> --effort high
/grok-build:review --wait --timeout-ms 120000 --max-turns 40
/grok-build:review --wait focus on auth error paths
```

The bridge launches roughly:

```bash
grok --prompt-file <file> --agent explore --no-plan --sandbox read-only \
  --disallowed-tools run_terminal_cmd,search_replace,search_tool,use_tool,write,monitor,image_gen,image_edit,image_to_video,reference_to_video,web_fetch,scheduler_create,scheduler_delete,scheduler_list \
  --deny Bash --deny Write --deny Edit --deny MCPTool \
  --cwd <ws> --output-format json
```

That is the real barrier: tool removal, deny rules, and sandbox where the OS enforces it. `--no-plan` is still on the launch line above because it is harmless and keeps parity with the TUI; a headless run does not read it, and plan mode cannot stall one, because the headless client approves leaving it. Do not call this "plan mode". On Windows the sandbox is not kernel-enforced — measured, not inferred: a direct run with the flag set wrote the file anyway — so tool removal and deny rules are the whole barrier there. On a Linux kernel without Landlock the bridge passes `--sandbox off` instead of `read-only`, because current CLIs refuse to start without the mechanism (grok 1.0.70, 2026-10-24); the example above is the profile passed everywhere else, including when the probe cannot tell. Both of those layers hold on Windows; neither is "the binding half" at the other's expense.

Optional flags: `--model`, `--effort` (`low`|`medium`|`high`|`xhigh`), `--timeout-ms <ms>`, `--max-turns <n>`, `--base <ref>`, `--scope auto|working-tree|branch`, `--wait` / `--background`, `--json`. If model/effort are omitted, Grok chooses defaults. Trailing words after flags are optional focus text (joined into the review prompt). Staged-only / unstaged-only scopes are not supported.

Review applies the same deliverable gate as other bridge paths: empty stdout on CLI exit 0 fails with exit `2` and `failureCode: no-deliverable`. See [Exit codes and failure classes](#exit-codes-and-failure-classes).

**What review actually sends.** The diff, plus the full contents of *untracked* text files, inline, up to **24 KiB each** — that content goes to the Grok service like everything else. Larger files, binaries and symlinks are replaced by a visible placeholder naming the reason rather than being read; symlinks in particular are named but never followed, since following one leaves the repository. Files git ignores are excluded, so the usual `.env` does not travel. If a file you expected to be reviewed is missing from the result, one of those limits is why.

### `/grok-build:critique`

Same target selection as review, with a design/risk critique prompt and structured JSON constrained by the review output schema:

```text
/grok-build:critique --wait
/grok-build:critique --base main challenge whether this was the right caching and retry design
/grok-build:critique --wait --model <model> --effort high focus on failure modes
/grok-build:critique --wait --timeout-ms 180000 --max-turns 50
```

The bridge launches roughly:

```bash
grok --prompt-file <file> --agent explore --no-plan --sandbox read-only \
  --disallowed-tools run_terminal_cmd,search_replace,search_tool,use_tool,write,monitor,image_gen,image_edit,image_to_video,reference_to_video,web_fetch,scheduler_create,scheduler_delete,scheduler_list \
  --deny Bash --deny Write --deny Edit --deny MCPTool \
  --cwd <ws> --output-format json --json-schema <review-schema>
```

Optional flags: same as review (`--model`, `--effort`, `--timeout-ms`, `--max-turns`, `--base`, `--scope`, `--wait` / `--background`, `--json`). Extra focus text after flags is supported. Same read-only write barrier as review, including `--sandbox off` on a Linux kernel without Landlock.

Critique fails with exit `2` when output is empty (`no-deliverable`) or when JSON is missing / unusable against the review shape (`schema-parse`). See [Exit codes and failure classes](#exit-codes-and-failure-classes).

### `/grok-build:delegate`

Delegate investigation or implementation to Grok via the `grok-build:grok-delegate` subagent (bridge command: `run`):

```text
/grok-build:delegate investigate the flaky test in auth
/grok-build:delegate --resume apply the top fix
/grok-build:delegate --model <model> --effort high fix the race
/grok-build:delegate --write --cwd packages/auth implement the retry helper
/grok-build:delegate --background --thread auth-debug dig into the race
/grok-build:delegate --json-schema '{"type":"object","properties":{"summary":{"type":"string"}}}' summarize findings
/grok-build:delegate --timeout-ms 300000 --max-turns 80 investigate hang
/grok-build:delegate --prompts-file prompts.ndjson
```

Write policy layering:

| Layer | Default |
| --- | --- |
| Bridge `run` CLI | **Read-only** unless you pass `--write`. Enforced by removing fourteen tools via `--disallowed-tools` — shell, editor, both MCP meta-tools, `write`, `monitor`, the media generators, `web_fetch` and all three scheduler tools — plus `--deny` rules for `Bash`/`Write`/`Edit`/`MCPTool`, with `--sandbox read-only` on top on Windows, where the flag is accepted and not enforced, and on macOS and on Linux when the probe says Landlock is present or cannot tell. On a Linux kernel without Landlock the bridge passes `--sandbox off` instead, because current CLIs refuse to start with `read-only` there (grok 1.0.70, 2026-10-24). Plan mode is not the barrier. `--no-plan` is still passed and a headless run ignores it; plan mode cannot stall a headless run, because the headless client approves leaving it. |
| Bridge `run --connector <name>` | Read-only, plus the connectors you name — see below. The two MCP meta-tools come back, the `MCPTool` deny rule is dropped, and each named connector gets one allow rule; every other barrier above stays. |
| Delegate agent / skill | Read-only as well; `--write` is added only for explicit implementation requests |

Note on `--sandbox`: xAI documents enforcement through Landlock and Seatbelt. Where neither is available, older CLIs continued without enforcement and without saying so — measured 2026-08-09 on Raspberry Pi OS (`6.12.96+rpt-rpi-2712`), where Landlock is compiled out, a write landed and stderr was empty, the same position as Windows. Current CLIs do not continue: grok 1.0.70 on that kernel, measured 2026-10-24, exits 1 before any model call and refuses to start, and the public 1.0.45 source already does. The bridge therefore passes `--sandbox off` on Linux when its probe says Landlock is absent, and `read-only` when the probe says present or cannot tell, and on every other platform. Windows is unchanged: the flag is still passed and still not enforced (grok 1.0.70, 2026-10-24, write landed, exit 0). Treat the sandbox as an extra layer where the kernel happens to provide one, never as the barrier — hence the tool removal and deny rules above, which hold everywhere.

- Direct `node …/grok-bridge.mjs run "…"` is therefore read-only unless `--write` is passed.
- `--connector <name>[,<name>…]` lets the run use connectors you have signed in to on the Grok side (xAI's managed MCP gateway: Google Calendar, Notion, GitHub and whatever else your account has), for example `run --connector google_calendar --prompt-file task.md`. **The login stays inside the Grok CLI**; neither this plugin nor Claude Code ever holds it. Each name becomes `--allow MCPTool(<name>__*)` and the run is pinned to `--permission-mode default`, so a call to a connector you did not name is cancelled — **unless your own settings already decide it**, because the CLI adds them on top: allow rules in your Grok config or Claude Code settings, "Always allow" answers saved in the Grok TUI for that repository, a Claude Code `defaultMode` of `auto` or `bypassPermissions`, or a local MCP server with the same name (`SECURITY.md` has the details). A named connector is fully open, including tools that create, send or delete, and the run is never retried automatically. To open less, name exact tools instead: `--connector google_calendar__search,google_calendar__get_event` allows those two and nothing else of that connector, which makes a read task read-only by mechanism rather than by prompt (measured 2026-09-23: with only `google_calendar__search` named, a `list_calendars` call was cancelled). Names are what the CLI prefixes tools with (`google_calendar` for `google_calendar__create_event`); give several as one comma-separated value, because a repeated `--connector` keeps only the last. Not with `--write`, `--background` or `--prompts-file`. The CLI loads the connector catalog a few seconds after the session starts, and until then `search_tool` answers `ready` with no tools; the bridge therefore opens every connector prompt with a short note that names the allowed connectors and tells the agent to keep calling `search_tool` until tools appear. The result does not list which tools the agent called — that record is in the Grok session history, under the session id in `--json`, where a large tool result is cut to about 20 KB and continues in the session's `mcp\` folder — so treat its account of what it read or changed as a claim and check the connector itself when it matters. The bridge does read that history for one thing: if the catalog never loaded at all — every search found no tools and every call found no such tool, which happened once in four runs on 2026-09-23 — the run fails with `connector-unavailable` instead of passing off an answer about an empty toolbox. Each connector run puts a marker (`grok-cc-run-` and random hex) into that prompt note, and the check grades only the history lines after the last user-message line that contains it, because the CLI rewrites `chat_history.jsonl` on resume and again when retained pruning replaces old tool results. A missing marker or connector calls with no sign either way leave the run inconclusive, and so does a child whose `started_at` falls in this run when the history otherwise reads as never loaded; `connectorCheck.reason` names which (`marker-missing`, `subagents`, `no-sign`), and a history that could not be read is a verdict of its own, `unreadable`. When the parent made no connector call and a child started during the run, the run keeps that verdict, with reason `subagents`, and the warning says the parent made none and the children's calls are not checked. A tool call cannot start that child on a read-only or connector run. Measured 2026-10-15 on grok 1.0.52 with this bridge's read-only flags: refused with "Denied by permission policy: deny rule on edit", and no subagents directory appeared. The check stays, because that refusal is a side effect of how the CLI classifies those tools, not a documented contract. The CLI can treat a prompt whose first character other than Unicode whitespace is `/` as a slash command, so a read-only `run` prompt that starts that way goes out behind a one-line bridge note and the run says so in its warnings; connector prompts already open with the bridge's note, and review and critique prompts are templates. `--verbatim` would not do this: in the 1.0.45 source it does not disable the slash dispatcher. And a call your `--connector` list does not cover is not just refused: a refusal that ends the run (`stopReason: cancelled`) fails it with `connector-refused`, even when an earlier search came back empty. A policy denial or an unresolved MCP permission that lets the run continue is counted and warned about, and the run is not failed. `connectorCheck` in `--json` says what the history showed, including how many calls were refused and the reason the check stopped short. `SECURITY.md` has what this mode does and does not protect.
- `--thread <name>` continues a named conversation for this workspace (registry per workspace, one run at a time per name). Without `--fresh`, an existing registration is resumed; with `--fresh`, that name starts a new Grok session and is re-registered only if the run delivers output. Names must be 1–64 characters: letters, digits, `.`, `-`, or `_`, starting alphanumeric. Reserved names `__proto__`, `constructor`, and `prototype` are rejected.
- `--json-schema '<schema>'` constrains the answer to JSON; the parsed object is exposed as `structured` in the `--json` payload, and a run that yields no JSON object fails. The schema string must be a JSON object and is size-capped at **16000 characters** (command-line limit guard).
- `--prompts-file <path>` runs a sequential NDJSON batch (one JSON string or `{"prompt":"…"}` object per non-empty line). Emits one NDJSON result object per prompt on stdout. Incompatible with `--background`, `--prompt-file`, and a positional prompt. Without `--thread`, later lines chain via resume of the previous line's session; with `--thread`, all lines share that named conversation.
- `--timeout-ms <ms>` is a wall-clock kill for the Grok process tree. `--max-turns <n>` is forwarded to the CLI.
- `--resume` / `--resume-last` continues the last stored Grok session id via `grok -r <id>`. Mutually exclusive with `--fresh`. `--thread` is mutually exclusive with `--resume-last`. `--fresh` is the default when neither resume nor an existing named thread applies; the flag exists so callers can be explicit and so combining it with resume fails loudly.
- Prefer bridge `--background` for long work so runs record both `bridgePid` (Node worker) and `agentPid` (grok child). Claude Code background is only for short enqueue of that bridge call.
- For `review` / `critique`, if both `--background` and `--wait` are present, **`--wait` wins** (foreground). `run` accepts `--background` only (no `--wait` flag on the bridge `run` command).
- `/grok-build:stop` terminates **both** process trees when present (agent then bridge/worker).
- If you do not pass `--model` or `--effort`, Grok chooses its own defaults. `--effort` takes `low`, `medium`, `high` or `xhigh`, and anything else is refused here before the CLI starts. ⚠ Those four are **measured, not copied**: the CLI's binary contains three further names (`none`, `minimal`, `max`) that look like part of the same set and are refused by the flag, and `grok --help` documents no values at all — so the only authoritative statement of the set is the CLI's own rejection, which you get by asking for a level that does not exist. Checked that way against CLI 1.0.5 and CLI 1.0.0, which answer identically. If a future CLI gains a level, this list has to be updated by hand and nothing here will notice on its own; that is a known gap rather than an oversight.
- Exit codes and `failureCode` for `run` / review / critique: see [Exit codes and failure classes](#exit-codes-and-failure-classes).
- Concurrency and the write barrier: see [Concurrency and write barrier](#concurrency-and-write-barrier).

### `/grok-build:runs`

List active and recent plugin-owned runs:

```text
/grok-build:runs
/grok-build:runs <run-id>
/grok-build:runs <run-id> --wait
/grok-build:runs <run-id> --wait --timeout-ms 120000
/grok-build:runs --all
/grok-build:runs --all-sessions
```

**Session scope (why history can look empty):**

| Mode | What you see |
| --- | --- |
| Default | Only runs whose `sessionId` matches the current Claude session (`GROK_CC_SESSION_ID`). Active runs for that session, the latest finished, and up to 8 other recent finished runs. |
| `--all` | Still scoped to the current Claude session, but the recent-finished list is not capped at 8. |
| `--all-sessions` | Every run recorded for this workspace, across Claude sessions. Recent list is uncapped; the table includes a Claude Session column. |

Finished runs from earlier Claude sessions are **kept** (SessionEnd does not delete history). They are hidden by the default session filter — use `--all-sessions` to see them. Retention prunes the oldest records, plus optional `clean` (bridge CLI). The cap of **50** (`MAX_JOBS`) applies per bucket, not to the workspace as a whole, so the total can legitimately exceed it:

- **Active runs** (`queued`, `running`) are never pruned. A retention policy must not delete a result at the moment it becomes available.
- **Survivors** — terminal records that still name an *agent* process, meaning a stop was attempted and could not be confirmed — keep the newest 50. That pid is the only way back to a process that may still be running, so it outlives ordinary history; it is capped all the same, because nothing sweeps a pid whose process died without a second stop. A leftover `bridgePid` does not make a survivor: the completion path leaves one on every finished record, and counting those would let ordinary history crowd out the record that matters.
- **Ordinary finished runs** keep the newest 50.

`--wait` requires a run id. Default wait timeout is 240000 ms. If the job is still active when the wait deadline expires, exit code is **3**.

Before listing, dead bridges (all kill-target PIDs gone) are reclaimed as failed orphans so they do not block the list forever.

### `/grok-build:show`

Show stored output for a finished run:

```text
/grok-build:show
/grok-build:show <run-id>
/grok-build:show <run-id> --wait
/grok-build:show <run-id> --wait --timeout-ms 120000
/grok-build:show <run-id> --strands
```

Without a run id, shows the latest finished run for the **current Claude session**. With an explicit id, any workspace run may be selected (id lookup is not session-filtered). Process exit reflects the stored run status (`0` completed success, non-zero failed/cancelled). `--wait` requires a run id; wait timeout exits **3** and prints status instead of the result.

**When Grok fans out to its own subagents, `show` reports each strand** — type, status, output size, tool calls — and warns when any of them produced nothing:

```text
Subagents: 6 (2 completed, 4 failed)
  ! [general-purpose] Adversarial audit probes — no output, 0 tools
  + [explore] Read-only explore attempt — 5204 chars, 7 tools
  + [deep-reasoner] Deep reason parser holes — 8008 chars, 50 tools
⚠ 4 of 6 strands produced nothing — this answer rests on 2.
```

That warning is the point. A half-dead fan-out costs exactly what a healthy one costs and returns an answer that reads just as confidently, so without this the difference was invisible. `--strands` prints each strand's full deliverable instead of the summary; either way the originals stay where the Grok CLI wrote them, under its own session directory.

### `/grok-build:stop`

Stop an active run by terminating tracked process trees:

```text
/grok-build:stop
/grok-build:stop <run-id>
```

Without a run id, stops the single active run for the current Claude session (errors if none or if several are active). Kills every distinct pid among `agentPid` (detached grok child) and `bridgePid` / legacy `companionPid` / legacy `pid` (bridge or run-worker). Terminal status is claimed under a locked CAS so a finishing worker cannot overwrite `cancelled` with `completed`.

## Exit codes and failure classes

Process exit alone is overloaded. Prefer `failureCode` in `--json` payloads when present.

| Exit | `failureCode` | Applies to | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `0` | `null` | `run`, review, critique | Deliverable present (non-empty model output; for schema runs, a usable JSON object / structuredOutput also counts) | Use the result. |
| `2` | `no-deliverable` | `run`, review, critique | CLI exited 0 but produced no usable output (after optional automatic nudge on read-only `run`) | Retry with a clearer prompt; do not assume side effects. |
| `2` | `connector-unavailable` | `run --connector` | The session history shows the connector catalog never loaded: searches came back empty or calls found no such tool, and nothing showed it loaded (a refused call counts neither way). Nothing reached the connector, whatever the reply says | Run it again; it is safe, because nothing happened, and it usually works. |
| `2` | `connector-refused` | `run --connector` | A connector call no allow rule of the run covers was refused, and the CLI ended the run on the spot (`stopReason: cancelled`), so nothing planned after it ran | Do not just re-run — it gets the same refusal. Name the tool in `--connector` if the call was intended, or take it out of the request. |
| `2` | `schema-parse` | `run` with `--json-schema`, critique | Output was **present but not usable** as a schema/review JSON object. A run that produced nothing at all is `no-deliverable`, not this — the schema is only judged once there is something to judge | Fix schema or prompt; keep `--json-schema` under 16000 characters. |
| `2` | `quota-exhausted` | `run`, review, critique | Grok refused the run for quota reasons: an HTTP 402, a 403 that says the credits have run out, or free-usage exhaustion. The bridge does not auto-retry it, because on a plan allowance retrying only burns time until the reset — but whether it can help at all is a property of your account, not of this code: credit can be topped up, and an account permitted to fall through to metered tokens may simply carry on. The tokens already spent on the failed run are still recorded. |
| `2` | `not-authenticated` | `run`, review, critique | Nobody is signed in. The CLI's own remedy (`grok login --device-code`, or `XAI_API_KEY`) is preserved in `rawOutput`. Retrying cannot help until someone logs in. |
| `2` | `max-turns` | `run`, review, critique | Grok hit `--max-turns` and stopped. The CLI still prints the text so far (a result envelope with `stopReason` `cancelled`, then `Error: max turns reached` on stderr, exit 1). Running the same request again hits the same limit | Raise `--max-turns` or narrow the task. The partial text is kept. |
| `2` | `output-truncated` | `run`, `review`, `critique` | Stdout exceeded the capture cap (default 32 MiB) and was truncated; never treated as success. A non-zero CLI status is classified first, so a run that both failed and overflowed reports `cli-error` | Narrow the task or raise capture only if you accept memory cost (`GROK_CC_STDOUT_CAP_BYTES`). |
| non-zero (often CLI status; timeout uses `1`) | `cli-error` | `run`, review, critique | Grok CLI failed | Check `grok models`, `GROK_BINARY`, auth; read stderr in the payload / log. |
| non-zero (often `1`) | `timeout` | `run`, review, critique | Wall-clock `--timeout-ms` killed the process tree | Raise `--timeout-ms`, reduce scope, or inspect partial log output. |
| `3` | (none) | `runs` / `show` with `--wait` | Wait deadline expired while the job was still active | Poll again or raise `--timeout-ms`. |
| non-zero | (none / stored) | `show`, `stop`, cancel paths | Stored failure/cancel, or stop / registry errors | Inspect `/grok-build:runs` and the job log. |

Notes:

- "Applies to" names the commands that talk to Grok. `check`, `runs`, `show`, `stop`, `threads`, `clean` and `usage` never produce a `failureCode`, because none of them launches an *agent* — there is no delegated run whose outcome could be classified. ⚠ That is not the same as "no CLI run": `check` does invoke `grok version` and `grok models` to probe the binary and the session, so it is not a purely local command. Whether those probes draw on your Grok allowance is xAI's to say and is not measured here.
- Automatic nudge (one retry into the same session) runs **only on read-only `run`** when the first attempt exits 0 with empty output. It never runs for `--write` or `--connector`, where a retry could repeat an action that already happened, and it is not used on review/critique.
- Review uses `--output-format json` and gates on non-empty final text, taking the envelope's text where there is one and raw stdout where there is not, so a review's usage reaches the spend ledger. Critique uses `--output-format json` plus the review JSON schema and gates on parse + review shape (`verdict`, `summary`, `findings`, `next_steps`).
- Cancelled runs never report process success (exit 0).
- `--timeout-ms` is a **best-effort deadline, not a hard one.** The run path performs synchronous work — resolving the binary, taking the state lock, and killing the process tree via `taskkill /T` — and each of those blocks the event loop, including the timer that enforces the deadline. On an idle machine the overshoot is a second or two. On a busy one it is much larger: measured 2026-07-28 under load, a 500 ms budget took about 19 seconds end to end, most of it before the agent was even spawned. What the deadline does guarantee is that the run ends and reports `failureCode: timeout` rather than hanging indefinitely. Callers that need a hard bound must impose their own on the bridge process.

## Concurrency and write barrier

**Machine-wide concurrency.** Concurrent Grok agent processes share a file-based semaphore under the resolved state root. Default cap is `max(8, 2 × logical CPUs)`. Set `GROK_CC_MAX_CONCURRENCY` to change it; `0` removes the bound. When every slot is taken, a new run **waits** up to `GROK_CC_SLOT_WAIT_MS` (default 90000), then **starts anyway** rather than failing — so a caller never has to count other agents before offloading. The bound is a runaway guard for unbounded fan-out, not a correctness lock: same-workspace job-list collisions use the state lock; same named conversation uses a per-thread lock. Processes with different `CLAUDE_PLUGIN_DATA` form **independent pools**.

**Per-thread lock.** Two `run --thread <name>` invocations for the same name cannot interleave turns in one Grok session. The second run fails immediately with a clear error until the first finishes or is stopped.

**Write barrier (read-only runs).** Enforcement order: (1) `--disallowed-tools` removes fourteen tools from the toolset — the shell, the file editor, the two MCP meta-tools, `write`, `monitor`, the four media generators, `web_fetch` and all three scheduler tools; (2) `--deny` rules reject `Bash` / `Write` / `Edit` / `MCPTool` if a tool reappears; (3) `--sandbox read-only` adds kernel enforcement **only where the OS actually provides a mechanism** — Seatbelt on macOS, Landlock on Linux *if that kernel has it*, which mainstream images such as Raspberry Pi OS do not. Where the probe says Landlock is absent, current CLIs refuse to start rather than run `read-only` without it (grok 1.0.70, measured 2026-10-24; an older CLI on 2026-08-09 accepted the flag, a write could land, and the CLI said nothing), so the bridge passes `--sandbox off` there and reports `kernelSandbox: "not-requested"`. On Windows the flag is still passed and still not enforced. **Every run, review and critique reports which of those applies on your machine** — in the `confinement` block of its `--json` payload, and in the printed result — rather than inferring it from the platform name. ⚠ `check` does **not** report it: the descriptor is attached where a run is launched, and `check` launches none. **Layers 1 and 2 hold everywhere, Windows included** — the ordering above is how much each is trusted, not which platforms each survives. Plan mode is never the barrier. The exact list is `READ_ONLY_DISALLOWED_TOOLS` in `grok-bridge.mjs`. Those ids were checked against `grok 1.0.0` on 2026-08-08; re-check with `check --verify-tools` after a CLI upgrade, because an id the CLI does not recognise is silently inert. `scheduler_list` is in the list for a second reason: the CLI's tools declare requirements on each other, and removing `scheduler_create` while `scheduler_list` survives stops the session from starting at all. An id can be real and still be fatal to remove alone — `check --verify-tools` asks the binary which ids it still recognises, and the acceptance suite starts a real session with the whole list.

## Bridge CLI surface (reference)

Direct invocations of `node …/grok-bridge.mjs` (slash commands shell these):

```text
check    [--verify-tools] [--fetch-update] [--json]
review   [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]
         [--model <model>] [--effort <low|medium|high|xhigh>]
         [--timeout-ms <ms>] [--max-turns <n>] [focus text]
critique [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]
         [--model <model>] [--effort <low|medium|high|xhigh>]
         [--timeout-ms <ms>] [--max-turns <n>] [focus text]
usage    [--days <n>] [--include-test-workspaces] [--json]
run      [--background] [--write | --connector <name>[,<name>...]]
         [--thread <name>] [--json-schema <json>]
         [--prompt-file <path>] [--prompts-file <path>]
         [--resume-last|--resume|--fresh (default)]
         [--model <model>] [--effort <low|medium|high|xhigh>]
         [--timeout-ms <ms>] [--max-turns <n>] [prompt]
runs     [run-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>]
         [--all] [--all-sessions] [--json]
show     [run-id] [--wait] [--strands] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]
stop     [run-id] [--json]
threads  [--forget <name>] [--json]
clean    [--keep <n>] [--older-than-ms <ms>] [--json]
disable  --reason "<why>" [--json]
enable   [--json]
```

Flag notes:

| Flags | Behaviour |
| --- | --- |
| `--background` + `--wait` (review/critique) | `--wait` wins → foreground |
| `--background` (`run`) | Detached worker; no `--wait` on `run` |
| `--write` | Opt-in mutating `run`; default is read-only barrier |
| `--connector <name>[,<name>…]` | `run` only: read-only plus the named Grok-side connectors, or exact tools as `<connector>__<tool>` (one comma-separated value; a repeated flag keeps the last). Foreground only — not with `--write`, `--background` or `--prompts-file`. Never auto-retried. |
| `--resume` / `--resume-last` vs `--fresh` | Mutually exclusive |
| `--thread` vs `--resume-last` | Mutually exclusive |
| `--fresh` | Explicit new session; with `--thread`, do not resume that name's stored session |
| `--json-schema` | JSON object string, max 16000 characters |
| `--prompts-file` | NDJSON batch for `run`; not with `--background` / `--prompt-file` / positional prompt |
| `--timeout-ms` | Wall-clock kill for agent runs; also wait deadline for `runs`/`show --wait` |
| `--max-turns` | Forwarded to the Grok CLI |
| `--all` | `runs`: uncapped recent list within current Claude session |
| `--all-sessions` | `runs`: every workspace job across Claude sessions |
| `--thread <name>` | 1–64 chars `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; not `__proto__` / `constructor` / `prototype` |
| `threads` / `clean` | Bridge-only helpers (list/forget named threads; prune terminal job history). `clean` requires `--keep` and/or `--older-than-ms` so it cannot wipe all history by accident. |
| `usage` | Bridge-only spend report: `--days <n>` (default 7), `--include-test-workspaces`, `--json`. See below. |
| `disable` / `enable` | A manual kill switch: `disable --reason "<why>"` stops `run`, `review` and `critique` from starting a Grok session, until `enable` clears it — including runs, reviews and critiques already waiting for a concurrency slot and the remaining lines of a `--prompts-file` batch, which check again right before they launch. `check --verify-tools` skips its test session and reports `checked: false`; its `grok version` and `grok models` probes still run, as with plain `check`, which keeps reporting normally and shows the reason. The flag is one file, `~/.grok-cc/disabled.json` in your home directory. `GROK_CC_DISABLED_FLAG` overrides the path: a leading `~`, `~/` or `~\` expands to the home directory, and a value that is still not absolute is refused so the bridge stays disabled rather than resolving the path against the process's working directory. The path does not depend on `CLAUDE_PLUGIN_DATA`: a `disable` from any shell stops the plugin too, and `disable` prints where it wrote. A flag file that exists but cannot be read, parsed or recognised counts as disabled. If that path cannot be written or removed, `disable` and `enable` name the path and the error code and exit non-zero. Deliberately manual rather than automatic — the CLI's own usage-percentage log (see "Knowing what the runs cost" below) is written only when an *interactive* session starts, so a bridge that only ever runs headlessly cannot keep it fresh enough to gate on safely. |

## Knowing what the runs cost

`usage` aggregates what the Grok CLI reported for each run across every workspace under the state root, with a per-day table. Spend is summed from `total_cost_usd_ticks`, the CLI's exact integer form (1 USD = 10^10 ticks) — its own documentation notes that these reconcile with the server's usage export while the dollar floats cannot. Records written before ticks were captured fall back to the float. A run the CLI marks `usage_is_incomplete` is reported separately rather than counted as free, because an unaccounted run is unmeasured, not cheap. Runs against the test fixture are excluded. Only runs recorded after this feature landed carry a cost; older records show tokens only.

It also prints the subscription's weekly usage percentage when it can find one. There is **no supported endpoint** for that number: the official CLI fetches its own billing config at session start and logs it, and this reads that local log back. Treat it as a hint, not a contract — the field names are not public, the log rotates, and the value is only as fresh as the last *interactive* CLI session — the headless runs this bridge starts do not write it. Every failure path returns nothing at all rather than a wrong number, and it never gates a run: a stale reading must not be able to stop work.

### Turning dollars into percent, and keeping it true

The ledger measures **spend**. The subscription page shows a **percentage**. Nothing connects the two, because no endpoint publishes the allowance behind the percentage — so the exchange rate has to be measured, and re-measured.

The measuring instrument is already in the room. You are running this plugin from a Claude Code session; that session can read `usage`, and you can read the subscription page. So hand it over occasionally, in one line:

```text
Subscription page says 68% used. Take a calibration point.
```

The session reads `usage`, divides spend by percent, appends the point to a file, and tells you whether the ratio moved. That is the whole method. It costs nothing, it needs no API, and it happens inside work you were doing anyway — which is the only reason it actually gets done.

**Do it repeatedly, not once.** A provider can change what a percentage point is worth whenever it likes: a different allowance, a different weighting of input against output against cache reads, a new plan tier. A ratio measured in July is a statement about July. A series that stays flat across many points is evidence; a single number is an anecdote, and it will keep looking correct long after it stopped being so.

Three things make a point worth recording, all learned by getting them wrong:

- **Read it when nothing is running.** An in-flight run has spent money the ledger has not seen yet, and the point silently lands low.
- **Use the cumulative quotient, not the step.** Percentages are shown as integers, so a single step from 66 to 68 can be anything from just over one point to nearly three. Step deltas scatter wildly while the running total converges — the convergence is the signal.
- **Sum every state root.** Runs started outside Claude Code land in the temp fallback, and a renamed marketplace creates a new plugin data directory. Reading one root and calling it the total is the easiest way to under-measure by a wide margin.

⚠ **The result is a lower bound, and knowingly so.** The ledger reads per-run job files, so anything it never recorded is invisible: runs whose accounting the CLI marked incomplete (reported separately), and runs on another machine drawing the same subscription. Retention also prunes old job files at `MAX_JOBS`, so a long enough window silently loses its own early history — that one is still open. Treat the figure as "at least this much" and expect the true rate to sit above it. Model calls the CLI makes on the side — compaction, memory capture and memory Dream consolidation — never appear in the per-run envelope and therefore never in this ledger. Since 0.4.0 the bridge turns memory off in its runs unless you set `GROK_MEMORY` yourself, which leaves compaction as the side spend it cannot see.

## Environment

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Optional override for the `grok` executable (or a `*.mjs` entry run via Node) |
| `GROK_CC_MAX_CONCURRENCY` | Machine-wide Grok agent cap. Default `max(8, 2 × logical CPUs)`. Set `0` to disable the semaphore. |
| `GROK_CC_SLOT_WAIT_MS` | How long to wait for a free slot before starting anyway (default `90000`). |
| `GROK_CC_STDOUT_CAP_BYTES` | Max captured agent stdout (default 32 MiB). Truncation fails the run with `output-truncated`. |
| `GROK_CC_UPDATE_CHECK` | Set `0` to stop the SessionEnd update check reaching GitHub. ⚠ `check --fetch-update` asks anyway — the variable stops the plugin acting on its own, not you asking explicitly. |
| `GROK_CC_SESSION_ID` | Claude session id (set by SessionStart hook) |
| `CLAUDE_PLUGIN_ROOT` | Plugin install root (host) |
| `CLAUDE_PLUGIN_DATA` | Plugin data root; state lives under `.../state`. Different values → independent concurrency pools. |
| `GROK_CC_DISABLED_FLAG` | Path of the kill-switch flag written by `disable` (default `~/.grok-cc/disabled.json`). A leading `~`, `~/` or `~\` expands to the home directory; a value that is still not an absolute path is refused and the bridge stays disabled. |
| `GROK_MEMORY` | The CLI's memory switch. The bridge sets `0` for every Grok session it starts, so a run does not store or recall anything between jobs; a value you set yourself, `1` included, is passed through unchanged. See SECURITY.md. |
| `GROK_CLAUDE_HOOKS_ENABLED` | The CLI's switch for running your Claude Code hooks inside Grok sessions, on by default. The bridge passes it through and does not set it; `false` turns your hooks off for bridge runs. See SECURITY.md. |
| `CLAUDE_ENV_FILE` | Host env file for session hooks |
| `CLAUDE_PROJECT_DIR` | Project directory from the host |

State fallback when `CLAUDE_PLUGIN_DATA` is unset: `$TMPDIR/grok-cc-runs-<username>` (username slug from the OS; suffix omitted only if the username cannot be resolved). On Windows, `$TMPDIR` is typically the process temp directory.

## Operations

### Session lifecycle

- **SessionStart** writes `GROK_CC_SESSION_ID` and `CLAUDE_PLUGIN_DATA` into the host env file so later bridge calls share session identity.
- **SessionEnd** cancels every **active** job recorded for that Claude session (including jobs started with `--cwd` in other workspaces during the session): marks them `cancelled` ("Stopped by session end.") and terminates their tracked process trees (`agentPid` / `bridgePid` / legacy pids). It does **not** rewrite or prune the job list — finished and cancelled records stay on disk so `/grok-build:show` and `--all-sessions` still work. Retention is the normal **MAX_JOBS (50)** prune on state writes, plus optional bridge `clean`. Background work does not keep running after the Claude session ends; its history does.

### State layout

Under the resolved state root (`$CLAUDE_PLUGIN_DATA/state` or the temp fallback):

```text
state/
  global-slots/          # machine-wide concurrency semaphore files
  <workspace-slug>-<hash>/
    state.json           # job list for this workspace
    state.json.lock
    named-threads.json   # --thread name → Grok session id
    thread-<name>.lock   # per-thread mutual exclusion
    jobs/
      <job-id>.json      # per-run record + log pointers
      <job-id>.log
```

Workspace directories are named `<basename>-<16-char-sha256-of-canonical-root>`.

The kill-switch flag is deliberately **not** under the state root: it is `~/.grok-cc/disabled.json`, so every state root on the machine obeys the same one. `GROK_CC_DISABLED_FLAG` overrides that path; a leading `~`, `~/` or `~\` expands to the home directory, and a value that is still not absolute is refused rather than resolved against the working directory. A `disabled.json` left under the state root is not read.

### Background lifecycle example

```text
# Start long work (bridge owns the process group)
/grok-build:delegate --background investigate the flake in auth

# List runs for this workspace / session
/grok-build:runs

# See runs from earlier Claude sessions in this workspace
/grok-build:runs --all-sessions

# Poll one run until terminal (or timeout)
/grok-build:runs <run-id> --wait

# Read stored output after completion
/grok-build:show <run-id>

# Cancel early
/grok-build:stop <run-id>
```

Prefer bridge `--background` so stop can kill both the Node worker and the grok child. Claude-only background without bridge `--background` does not give the plugin stable PID ownership.

### Failure modes (operator guide)

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| A `/grok-build:*` command fails with a **shell parse error**, or returns **exit 0 with no output at all** | Almost certainly the Claude Code **Bash tool**, not this plugin. Every command here runs through it, so its failures surface from inside our commands and read as ours. On Windows, an oversized `bash -c` argument is truncated silently: the cut can land mid-quote (parse error) or on a line boundary (**exit 0, empty output, your command never ran**) | Update to **0.3.2 or later** — versions before it grew `CLAUDE_ENV_FILE` on every SessionStart until it crossed the limit. If it persists on 0.3.2+, test with a bare `echo ok` through the Bash tool: if that also fails, the cause is outside this plugin. |
| Slot wait messages, then run starts | Concurrency cap full for the wait window | Expected; raise `GROK_CC_MAX_CONCURRENCY`, wait for other agents, or leave default (start-anyway after wait). |
| `thread "…" is already in use` | Another run holds that named thread lock | Wait, use another `--thread` name, or stop the holder. |
| Exit `2` + `failureCode: no-deliverable` | Empty model output after optional read-only nudge | Retry with clearer prompt; do not assume write side effects. |
| Exit `2` + `failureCode: schema-parse` | Schema/critique JSON missing or unusable | Fix schema or prompt; keep schema under 16000 chars. |
| Exit `2` + `failureCode: connector-unavailable` | The connector catalog never loaded in that run | Run it again — nothing reached the connector. |
| Exit `2` + `failureCode: connector-refused` | A call outside the run's `--connector` list was refused, which ended the run | Widen `--connector` or change the request; a plain re-run is refused again. |
| Exit `2` + `failureCode: output-truncated` | Agent stdout exceeded capture cap | Narrow task; inspect partial log; only raise `GROK_CC_STDOUT_CAP_BYTES` if needed. |
| `failureCode: timeout` | `--timeout-ms` wall clock hit | Raise timeout or reduce work; check partial log. |
| `failureCode: cli-error` | Grok CLI non-zero status | Check `grok models`, `GROK_BINARY`, auth; read stderr in the payload. |
| Exit `2` + `failureCode: max-turns` | The CLI's turn limit was exhausted | Raise `--max-turns` or narrow the task. The text so far is kept; a plain re-run hits the same limit. |
| Exit `3` on `runs`/`show --wait` | Wait deadline while still active | Poll again or raise `--timeout-ms`. |
| `/grok-build:runs` empty but you know work ran | Default session filter | Use `--all-sessions` (history is kept after SessionEnd). |
| State lock timeouts | Contended `state.json.lock` or stale holder | Retry; on hard corruption delete the workspace state dir only if you accept losing run history. |
| Result printed but `runs` still shows the job active | State volume full or read-only; the run finished but could not be recorded | Free space, then re-run. The answer is not lost — see below. |
| `[grok-cc] Bridge state file was corrupt…` | `state.json` failed to parse | Nothing to do: it was quarantined and the index was rebuilt from the job files. The quarantined copy is kept next to it. |
| Named-thread registry corrupt | Bad `named-threads.json` | Delete that file to start over (error text says so). |
| Windows "Select an app to open grok" | Binary not resolved / shell spawn | Set `GROK_BINARY` to the real executable; keep `grok` on PATH. |
| Session closed, background agent gone | SessionEnd cancels active runs | Restart the work in a new session; records remain for `--all-sessions` / `show`. |
| `/grok-build:stop` does nothing useful | Run was Claude-background only without bridge `--background` | Always enqueue long work with bridge `--background`. |
| Hooks never fire; `GROK_CC_SESSION_ID` unset | `node` is not on the PATH of the shell that launched Claude Code | The hooks invoke a bare `node` and fail silently when it is missing. Put Node on the persistent user PATH, not just the current shell. |

### When the state volume cannot be written

Everything the bridge remembers lives under the plugin data directory. If that volume fills up or turns read-only mid-run, the run itself is unaffected — the agent is a separate process talking to the network — but nothing about it can be recorded. The bridge is built so that this degrades rather than destroys:

- A finished result is still returned to the caller, with `persisted: false` and the reason. You get your answer; only the stored copy is missing.
- No process is killed on the strength of a decision that could not be recorded. A run whose progress writes are failing looks stale, and reclaiming it is exactly the wrong move, so a failed claim aborts the reclaim.
- `runs`, `stop` and `show --wait` keep listing what they can instead of failing outright.
- A corrupt index is rebuilt from the per-job files rather than throwing.

One case cannot be repaired from inside the bridge: if progress writes fail before the agent's process id has been recorded **and** the bridge is then hard-killed, nothing on disk points at the agent, and it keeps running until it finishes on its own. Recording the id needs a writable volume, so there is no fix at that layer — check for stray `grok` processes after a crash on a full disk.

### Flag matrix (slash → bridge)

| Slash command | Bridge command | Background | Write | Focus text |
| --- | --- | --- | --- | --- |
| `/grok-build:review` | `review` | `--background` / `--wait` (wait wins) | always read-only barrier | optional trailing words |
| `/grok-build:critique` | `critique` | same | always read-only barrier | optional trailing words |
| `/grok-build:delegate` | `run` via subagent | bridge `--background` for long work | default RO; `--write` opt-in | task text after flags |
| `/grok-build:runs` | `runs` | n/a (`--wait` polls a run id) | n/a | n/a |
| `/grok-build:show` / `stop` | `show` / `stop` | n/a | n/a | n/a |

## Development

```bash
npm test
```

No `npm install` is needed — there are no dependencies.

What a healthy checkout looks like is **`0 fail`, and at most one skip** — which test skips is platform-dependent: on Linux and macOS the Windows-only `PATHEXT` resolution test, on Windows the symlink test, but only where the host denies symlink creation (no elevation, no Developer Mode), so an elevated Windows box skips neither. Those two numbers are the invariant; the total only ever grows and is not worth comparing against a number written down here. A second skip is a finding: it means a test opted out on your platform, and the summary line reports that in the same calm voice as a pass.

Tests use Node's built-in test runner and a fake `grok` binary on `PATH`. Runtime code uses Node stdlib only.

Version: the source of truth is `package.json`; `npm run bump-version <x.y.z>` propagates it to `plugins/grok-build/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and CI runs `npm run check-version`, which fails on drift. No number is written here, because nothing would keep it honest.

## Contributing

Bug fixes with a reproduction are welcome as a pull request. For anything larger — a feature, a new command, a change to how a barrier works — open an issue first and let's agree the shape before you write code, so nobody spends an evening on something that gets turned down for a reason nobody said out loud. [CONTRIBUTING.md](CONTRIBUTING.md) has the full process, including what the test suite expects and how to run the acceptance gates.

## License

Apache-2.0. See [LICENSE](LICENSE) for the terms and [NOTICE](NOTICE) for the attribution, the modification notice and the trademarks.

---

| | |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | What differs from the upstream baseline, and why |
| [ROADMAP.md](ROADMAP.md) | What is likely to grow next, and what deliberately is not |
| [SECURITY.md](SECURITY.md) | What each mode protects, what it does not, and how to report a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to propose a change and what the suite expects |
| [docs/ADOPTION.md](docs/ADOPTION.md) | Getting Claude Code to actually reach for it |
| [NOTICE](NOTICE) | Attribution, modification notice, trademarks |
| [LICENSE](LICENSE) | Apache-2.0 |

Maintained by Kai Wedekind — [@KaiWedekind](https://x.com/KaiWedekind) on 𝕏.

Bugs go in an [issue](../../issues); the template asks for the job record, which is pruned after fifty runs in a workspace, so copy it out before it is gone. Security reports go through the private channel in [SECURITY.md](SECURITY.md), not a public issue. Anything else — a question, or that it was useful — 𝕏 is fine and probably faster.
