#!/usr/bin/env node
/**
 * check-upstream.mjs — report commits on an upstream remote newer than a
 * last-reviewed marker. Silence means "nothing new since you last looked".
 *
 * Does NOT merge, rebase, pull, checkout, or touch the working tree.
 * The only write is `git fetch <remote> <branch>` (remote-tracking ref).
 *
 * Exit codes (branch on these — see PowerShell note below):
 *   0  nothing new since the reviewed marker
 *   1  new commits found  (only with --check; plain run stays 0 so a
 *      human report is not a hard failure)
 *   2  usage error, missing remote, bad marker, network/fetch failure,
 *      or any other hard failure — NEVER confused with "nothing new"
 *
 * PowerShell consumers: `if (node …)` tests OUTPUT presence, not exit code.
 * Always branch on $LASTEXITCODE (or `if ($LASTEXITCODE -ne 0)`).
 * This script prints the human report to stdout and diagnostics that are
 * not the "new commits" report to stderr. Do not gate on stderr silence.
 *
 * Usage:
 *   node check-upstream.mjs [--repo <path>] [--remote <name>] [--branch <name>]
 *                           [--state <path>] [--no-fetch]
 *                           [--mark <sha> [--notes <text>]]
 *                           [--check]
 *                           [--help]
 *
 * Defaults:
 *   --repo     current working directory
 *   --remote   upstream
 *   --branch   main
 *   --state    <dir-of-this-script>/check-upstream-state.json
 *
 * State file (JSON):
 *   { "reviewedSha": "<full-or-short>", "reviewedAt": "<ISO-8601>", "notes": "…" }
 *
 * Examples:
 *   node check-upstream.mjs --repo C:\path\to\fork
 *   node check-upstream.mjs --repo C:\path\to\fork --check
 *   node check-upstream.mjs --repo C:\path\to\fork --mark 92b76a6 --notes "triaged 0.2.1"
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE = join(SCRIPT_DIR, "check-upstream-state.json");

const EXIT_OK = 0;
const EXIT_NEW = 1;
const EXIT_ERR = 2;

function usage(stream = process.stderr) {
  stream.write(`Usage: node check-upstream.mjs [options]

  --repo <path>       Fork repository (default: cwd)
  --remote <name>     Upstream remote name (default: upstream)
  --branch <name>     Remote branch to watch (default: main)
  --state <path>      Marker state JSON (default: next to this script)
  --mark <sha>        Record <sha> as last-reviewed and exit
  --notes <text>      Free-text notes stored with --mark
  --check             Exit 1 when new commits exist (hard gate)
  --no-fetch          Skip git fetch; use existing remote-tracking refs
  --help              Show this help

Exit codes: 0 = nothing new, 1 = new commits (--check only), 2 = error.
PowerShell: branch on $LASTEXITCODE, not if (node …).
`);
}

function fail(message, detail) {
  process.stderr.write(`error: ${message}\n`);
  if (detail) {
    const text = String(detail).trim();
    if (text) process.stderr.write(`${text}\n`);
  }
  process.exit(EXIT_ERR);
}

function parseArgs(argv) {
  const opts = {
    repo: process.cwd(),
    remote: "upstream",
    branch: "main",
    state: DEFAULT_STATE,
    mark: null,
    notes: "",
    check: false,
    noFetch: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (name) => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        fail(`missing value for ${name}`);
      }
      return argv[++i];
    };
    switch (a) {
      case "--repo":
        opts.repo = need(a);
        break;
      case "--remote":
        opts.remote = need(a);
        break;
      case "--branch":
        opts.branch = need(a);
        break;
      case "--state":
        opts.state = need(a);
        break;
      case "--mark":
        opts.mark = need(a);
        break;
      case "--notes":
        opts.notes = need(a);
        break;
      case "--check":
        opts.check = true;
        break;
      case "--no-fetch":
        opts.noFetch = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        fail(`unknown argument: ${a}\nRun with --help for usage.`);
    }
  }
  return opts;
}

/**
 * Run git without a shell. Paths with spaces are safe as argv elements.
 * Returns { ok, status, stdout, stderr, error }.
 * Distinguishes spawn failure (git missing) from git non-zero exit.
 */
function git(repo, args) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
    // Explicit: never shell — avoids PowerShell/cmd quoting and injection.
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: result.error,
      spawnFailed: true,
    };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: null,
    spawnFailed: false,
  };
}

function requireGitOk(repo, args, what) {
  const r = git(repo, args);
  if (r.spawnFailed) {
    fail(
      `cannot run git (${what}): ${r.error.message}`,
      "Is git on PATH for this Node process?"
    );
  }
  if (!r.ok) {
    fail(
      `${what} failed (git exit ${r.status})`,
      [r.stderr, r.stdout].filter(Boolean).join("\n")
    );
  }
  return r;
}

function loadState(path) {
  if (!existsSync(path)) {
    return null;
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    fail(`cannot read state file: ${path}`, e.message);
  }
  let data;
  try {
    // Strip a UTF-8 BOM before parsing. On Windows every ordinary way of
    // hand-editing this file writes one — Set-Content -Encoding utf8, Out-File
    // and Notepad all do — and JSON.parse rejects a leading U+FEFF as a syntax
    // error. The failure was already safe (exit 2, never "nothing new"), but it
    // made a hand-edited marker unusable for no good reason.
    data = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    fail(`state file is not valid JSON: ${path}`, e.message);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail(`state file must be a JSON object: ${path}`);
  }
  return data;
}

function saveState(path, data) {
  const dir = dirname(path);
  try {
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch (e) {
    fail(`cannot write state file: ${path}`, e.message);
  }
}

function resolvePath(p) {
  return isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage(process.stdout);
    process.exit(EXIT_OK);
  }

  const repo = resolvePath(opts.repo);
  const statePath = resolvePath(opts.state);

  if (!existsSync(repo)) {
    fail(`repo path does not exist: ${repo}`);
  }
  const gitDir = git(repo, ["rev-parse", "--git-dir"]);
  if (gitDir.spawnFailed) {
    fail(`cannot run git: ${gitDir.error.message}`);
  }
  if (!gitDir.ok) {
    fail(`not a git repository: ${repo}`, gitDir.stderr);
  }

  // --- --mark: record reviewed marker and exit ---
  if (opts.mark !== null) {
    const resolved = requireGitOk(
      repo,
      ["rev-parse", "--verify", `${opts.mark}^{commit}`],
      `resolve mark sha ${opts.mark}`
    );
    const full = resolved.stdout.trim();
    const short = requireGitOk(
      repo,
      ["rev-parse", "--short", full],
      "shorten mark sha"
    ).stdout.trim();

    const prev = loadState(statePath);
    const notes =
      opts.notes !== ""
        ? opts.notes
        : prev && typeof prev.notes === "string"
          ? prev.notes
          : "";

    const state = {
      reviewedSha: full,
      reviewedAt: new Date().toISOString(),
      notes,
    };
    saveState(statePath, state);
    process.stdout.write(
      `Marked reviewed: ${short} (${full})\n` +
        `  at:    ${state.reviewedAt}\n` +
        `  state: ${statePath}\n` +
        (notes ? `  notes: ${notes}\n` : "")
    );
    process.exit(EXIT_OK);
  }

  // --- check mode needs a marker ---
  const state = loadState(statePath);
  if (!state) {
    fail(
      `no state file at ${statePath}`,
      "Create one with: node check-upstream.mjs --mark <sha> [--state <path>]"
    );
  }
  if (!state.reviewedSha || typeof state.reviewedSha !== "string") {
    fail(
      `state file missing reviewedSha: ${statePath}`,
      'Expected { "reviewedSha": "…", "reviewedAt": "…", "notes": "…" }'
    );
  }

  // Resolve marker first — a bad marker must never look like "nothing new".
  const markerResolve = git(repo, [
    "rev-parse",
    "--verify",
    `${state.reviewedSha}^{commit}`,
  ]);
  if (markerResolve.spawnFailed) {
    fail(`cannot run git: ${markerResolve.error.message}`);
  }
  if (!markerResolve.ok) {
    fail(
      `reviewed marker is not a known commit: ${state.reviewedSha}`,
      `state file: ${statePath}\n${markerResolve.stderr.trim()}`
    );
  }
  const markerFull = markerResolve.stdout.trim();
  const markerShort = requireGitOk(
    repo,
    ["rev-parse", "--short", markerFull],
    "shorten marker"
  ).stdout.trim();

  // Remote must exist — distinct failure from network and from "nothing new".
  const remoteUrl = git(repo, ["remote", "get-url", opts.remote]);
  if (remoteUrl.spawnFailed) {
    fail(`cannot run git: ${remoteUrl.error.message}`);
  }
  if (!remoteUrl.ok) {
    fail(
      `remote "${opts.remote}" is not configured in ${repo}`,
      `git remote get-url ${opts.remote} failed (exit ${remoteUrl.status}).\n` +
        `Configure with: git remote add ${opts.remote} <url>\n` +
        (remoteUrl.stderr.trim() || remoteUrl.stdout.trim())
    );
  }

  const trackingRef = `${opts.remote}/${opts.branch}`;

  // Fetch: only allowed write. Announce it.
  if (!opts.noFetch) {
    process.stdout.write(
      `Fetching ${opts.remote} ${opts.branch} (updates remote-tracking ref only)…\n`
    );
    const fetched = git(repo, [
      "fetch",
      "--no-tags",
      opts.remote,
      opts.branch,
    ]);
    if (fetched.spawnFailed) {
      fail(`cannot run git fetch: ${fetched.error.message}`);
    }
    if (!fetched.ok) {
      // Network / auth / server failure — must not look like "nothing new".
      fail(
        `git fetch ${opts.remote} ${opts.branch} failed (exit ${fetched.status})`,
        [
          "This is a network/remote failure, not an empty review.",
          fetched.stderr.trim(),
          fetched.stdout.trim(),
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  }

  // Tracking ref must exist after fetch (or with --no-fetch).
  const tipResolve = git(repo, [
    "rev-parse",
    "--verify",
    `${trackingRef}^{commit}`,
  ]);
  if (tipResolve.spawnFailed) {
    fail(`cannot run git: ${tipResolve.error.message}`);
  }
  if (!tipResolve.ok) {
    fail(
      `remote-tracking ref not found: ${trackingRef}`,
      `Fetch may never have succeeded, or branch "${opts.branch}" does not exist on remote "${opts.remote}".\n` +
        tipResolve.stderr.trim()
    );
  }
  const tipFull = tipResolve.stdout.trim();
  const tipShort = requireGitOk(
    repo,
    ["rev-parse", "--short", tipFull],
    "shorten tip"
  ).stdout.trim();

  // List commits strictly after the marker, reachable from upstream tip.
  // Format: shortsha | ISO-date | author | subject
  const log = git(repo, [
    "log",
    "--reverse",
    "--format=%h%x09%ad%x09%an%x09%s",
    "--date=short",
    `${markerFull}..${tipFull}`,
  ]);
  if (log.spawnFailed) {
    fail(`cannot run git log: ${log.error.message}`);
  }
  if (!log.ok) {
    // Range errors, corrupt objects, etc. — never map to "nothing new".
    fail(
      `git log ${markerShort}..${tipShort} failed (exit ${log.status})`,
      log.stderr.trim() || log.stdout.trim()
    );
  }

  // Successful empty stdout is the only path to "nothing new".
  const lines = log.stdout
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  const reviewedAt =
    typeof state.reviewedAt === "string" && state.reviewedAt
      ? state.reviewedAt
      : "(unknown)";
  const notes =
    typeof state.notes === "string" && state.notes ? state.notes : "";

  if (lines.length === 0) {
    process.stdout.write(
      `Nothing new upstream since ${markerShort}` +
        ` (reviewed ${reviewedAt}` +
        (notes ? `; ${notes}` : "") +
        `).\n` +
        `  tip: ${trackingRef} @ ${tipShort}\n`
    );
    process.exit(EXIT_OK);
  }

  process.stdout.write(
    `${lines.length} new commit(s) on ${trackingRef} since ${markerShort}` +
      ` (reviewed ${reviewedAt}` +
      (notes ? `; ${notes}` : "") +
      `):\n`
  );
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 4) {
      // Unexpected format — still show the raw line, never drop evidence.
      process.stdout.write(`  ${line}\n`);
      continue;
    }
    const [sha, date, author, ...subjectParts] = parts;
    const subject = subjectParts.join("\t");
    process.stdout.write(`  ${sha}  ${date}  ${author}  ${subject}\n`);
  }
  process.stdout.write(
    `\nAfter triage: node check-upstream.mjs --mark <sha> --state "${statePath}"\n`
  );

  if (opts.check) {
    process.exit(EXIT_NEW);
  }
  process.exit(EXIT_OK);
}

main();
