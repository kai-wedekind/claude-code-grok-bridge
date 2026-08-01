# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Report a vulnerability" on
the Security tab) rather than a public issue. That keeps the report private until
a fix exists.

This is a personal fork maintained alongside other work, so please do not expect a
same-day response.

## What this plugin does with your data

**It runs an external CLI.** Every task is handed to the real `grok` binary, which
sends it to the Grok service. Prompts, file contents the agent reads, and its output leave your
machine. Nothing in this plugin changes that, and no local setting prevents it.

**Prompts and results are written to disk.** Job records, logs, and state live
under the plugin data directory. Prompts too long for the command line are written
to a temporary file that is deleted after the run. Job logs, state files and those
temporary prompt files are created `0600`. On Windows that mode is largely
advisory — treat the state directory as readable by anything running as your user.

**Secret-shaped strings are redacted** in job logs and in the progress text stored
on job records: `sk-…`, `xai-…`, `Bearer …`, and `KEY=`/`TOKEN=`/`SECRET=`
assignments. This is a safety net for accidental leakage into diagnostics, not a
guarantee. Do not put credentials in prompts.

**The request and the model's result are stored verbatim, and that is deliberate.**
Redaction covers the diagnostic surfaces named above; the run's actual output —
`result` and the rendered text on the job record — is written exactly as it came back.
It has to be: it is the deliverable you read, and a review of code that discusses key
formats would be mangled by a filter that cannot tell a quoted example from a live
credential. The request is kept the same way: a background run persists the whole
request on its job record, prompt included, and the opening of that prompt becomes the
run's summary in the workspace state index. The consequence is worth stating plainly
rather than leaving to be discovered: anything the model echoes back, including a
secret it was shown, lands on disk unredacted under the plugin data directory — and so
does a secret pasted into the prompt, which is the likelier place for one to appear.

**The `grok` CLI child inherits a filtered environment**, not your full one. What passes: a
small fixed list of OS variables the process needs to start (`PATH`, `PATHEXT`, `SystemRoot`,
the temp directories, locale), plus anything beginning `GROK_` or `XAI_` — the credentials
the CLI itself needs. Nothing else reaches it — in particular not other vendors' API keys,
which a process talking to Grok has no use for. This allowlist is the fork's own; upstream
has none, so do not assume this behaviour of the original plugin.

The filter covers the process that talks to somebody else's service, and only that one. The
OS helpers the bridge runs to look at processes (`tasklist`, `ps`, `taskkill`) and its own
detached run-worker are handed the full environment: they are local utilities and this
program re-executing itself, not third parties.

`NODE_OPTIONS` and `NODE_PATH` are also deliberately **not** forwarded. They are the two
best-known ways to make a Node process load code nobody asked for — `--require` runs a file
before anything else, and `NODE_PATH` redirects bare module resolution — and the CLI does
not need either. The parent environment belongs to the user, so this is not a remote attack
path; it is one step fewer for anyone who already has that environment, which is what a
filter is for.

## The CLI can send more than the task, and that is its setting to change, not this plugin's

Everything above is about what the *bridge* does. The `grok` CLI has a second channel of its
own, separate from inference, and it is worth knowing about because nothing here touches it:
telemetry and a per-turn trace-upload pipeline. This plugin uploads nothing on its own — it
runs the CLI you already have, under your own account — so what follows is a property of that
CLI, and the knobs belong to it.

Verified against the CLI installed here, which carries its own documentation inside the
binary:

| What | How to turn it off |
|---|---|
| Coding data sharing | `grok`, then `/privacy` |
| Telemetry | `GROK_TELEMETRY_ENABLED=0`, or `[features] telemetry` in `config.toml` |
| Per-turn trace upload | `GROK_TELEMETRY_TRACE_UPLOAD=0`, or `[telemetry] trace_upload` |
| Feedback collection | `GROK_FEEDBACK_ENABLED=0` |
| Error reporting | `DISABLE_ERROR_REPORTING=1` |

Two honest limits on that table. First, these are the CLI's own knobs and the CLI is xAI's
software: what each one covers, whether any of it is additionally gated server-side, and how
long anything is retained are theirs to define and change — check their current terms rather
than trusting a list written here. Second, the bridge forwards `GROK_*` and `XAI_*` to the
child (see above), so setting these in the environment does reach the CLI when the bridge
launches it — but a setting you make only in your shell will not follow a run started from
somewhere else. Put them where they will be there every time.

Credit where it is due: this exposure was pointed out to us by
[tylersue/claude-grok-delegation](https://github.com/tylersue/claude-grok-delegation), which
documents it in its own security notes. We verified the knobs against the installed CLI
before writing them down here rather than repeating them on trust — and you should treat this
table the same way.

## Stopping a run checks what it is about to signal

`stop`, `SessionEnd` and the reclaim path terminate processes by pid, and those pids come
off a job record that may be days old. Operating systems reissue pids, so the number alone
is not an identity.

Every record therefore stores the image name of what it started — `bridgeImage` for the
bridge process, `agentImage` for the Grok agent — and every kill probes the target and
compares before signalling. A mismatch is reported as `image-mismatch` and nothing is
terminated.

A record that carries a pid and no name gets a weaker check rather than none: the target
must at least be one of the two things a run can start — this interpreter, or the configured
`grok` binary (`GROK_BINARY` is honoured). Anything else is refused.

A probe that cannot read the image at all still allows the kill. That is about platforms
where the process table is unreadable, not about records that never said.

## Repository content is not trusted input

`review`, `critique` and `run` put repository content into the prompt: the diff, and the
contents of untracked files up to 24 KiB each. That content is written by whoever wrote the
repository, and a language model does not reliably distinguish "text I was asked to review"
from "instruction addressed to me".

The practical rule follows from that, and it is the one thing worth knowing before pointing
this at code you did not write:

- **Do not pass `--write` on a repository you do not trust.** In write mode the agent has
  `Bash`, `Write` and `Edit` in that working directory. A file in the repository that tells
  it what to do is an input it may act on.
- Read-only mode is the defence, and it is a real one **for the integrity of your machine**:
  the writing tools are removed rather than merely discouraged, so the worst case is a
  misleading review and not a modified machine.
- **It is not a defence of confidentiality, and the difference matters here.** No *reading*
  tool is removed — that is what the mode is for. So instructions planted in a repository can
  still ask the agent to pull other files from the working directory into its prompt and to
  restate their contents in the review, and both of those leave your machine. Reviewing a
  hostile repository read-only protects what you keep; it does not protect what you show.
  Point `--cwd` at the repository under review and nothing wider, and read the result before
  you trust it.
- Files ignored by git are excluded (`--exclude-standard`), so the usual `.env` does not
  travel. Symlinks are detected with `lstat` and named without being opened — reading them
  would follow the link out of the repository, which is exactly the defect this fork
  inherited and fixed (upstream `xai-org/grok-build-plugin-cc` issue #4, opened
  2026-07-16 and still open there when last checked 2026-08-01).

There is no sanitisation of repository content, and none is claimed. Treat the read-only
barrier as the boundary.

## The read-only barrier

`run` is read-only unless `--write` is passed. The barrier is enforced by removing
the writing tools from the agent (`--disallowed-tools`) and adding deny rules for
`Bash`, `Write`, `Edit` and `MCPTool`.

`--sandbox read-only` is passed as well, but **it is not the barrier**: the Grok
CLI only enforces it through Landlock or Seatbelt, so on Windows it does nothing
and prints that it continues without enforcement. A "read-only" run under sandbox
alone could create files there — this was reproduced, and is why the barrier sits
at the tool layer.

The barrier is applied on every launch path: foreground, background worker, the
automatic retry, and review/critique. Delegating to a sub-agent does not escape it;
that was tested rather than assumed.
