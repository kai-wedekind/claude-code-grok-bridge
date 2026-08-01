/**
 * An unauthenticated client is a failure with a remedy, and the caller has to hear it.
 *
 * Found by running the acceptance suite against a real, signed-out Grok CLI on an aarch64
 * host (2026-07-31). Six of eleven checks failed separately and none of them said why;
 * the shared cause was a single lapsed session. Every failure that needed a real run came
 * back as the generic `cli-error`, which reads like "the CLI blew up" and invites a retry
 * that cannot possibly work.
 *
 * The wire shape below is captured verbatim from grok 0.2.117: a JSON envelope on STDOUT
 * — not stderr — carrying its own remedy in the message.
 */
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { looksLikeAuthFailure } from "../plugins/grok-build/scripts/lib/grok.mjs";
import { scrubSecrets } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

const REAL_PAYLOAD = JSON.stringify({
  type: "error",
  message:
    "Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\n" +
    "Alternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser."
});

test("the real signed-out payload is recognised", () => {
  assert.equal(looksLikeAuthFailure(REAL_PAYLOAD), true);
});

test("two independent hints are required, so a task that merely mentions login is not one", () => {
  // A single hint is not enough on purpose. Sending someone to re-authenticate over an
  // unrelated failure wastes their time and hides the real cause; missing one only falls
  // back to the generic code, which is what happened before this existed.
  assert.equal(
    looksLikeAuthFailure(JSON.stringify({ type: "error", message: "run grok login first" })),
    false,
    "one hint alone must not classify"
  );
  assert.equal(looksLikeAuthFailure(""), false);
  assert.equal(looksLikeAuthFailure(null), false);
  assert.equal(
    looksLikeAuthFailure("Reviewed the auth module; it reads XAI_API_KEY at startup."),
    false,
    "prose about authentication is not an authentication failure"
  );
});

/**
 * The models probe judges a different kind of text than the run path, and needs a different
 * threshold to do it. Found on Windows on 2026-07-31: a `grok models` that landed
 * inside an OIDC token refresh exited 0 while printing "You are not authenticated.", and
 * `check` answered
 * "Status: ready" — the one word a caller acts on — for a machine that could not run anything.
 *
 * The first proposed fix was to reuse this predicate as-is. It would not have worked: the
 * observed string carries exactly ONE hint, and the default rule demands two. That is the
 * whole reason `minHints` exists, so the asymmetry is pinned here rather than left to a
 * comment somebody can delete.
 *
 * Confirmed against the real event, not only this fixture. On the same day at 18:25:24Z
 * the CLI was left untouched until its access token expired and `check --json` was the
 * first call afterwards: `ready: false`, `auth.detail` the CLI's own wording, and
 * `oidc refresh enter … is_expired:true` in the client log to prove the precondition was
 * actually met. The refresh took 373 ms. Two observations six hours apart, same shape —
 * the fixture below reproduces a thing that happens, not a thing that was imagined.
 */
test("the observed denial needs the probe threshold, not the default one", () => {
  const observed = "You are not authenticated.";
  assert.equal(
    looksLikeAuthFailure(observed),
    false,
    "default stays at two hints — a single mention must not classify task output"
  );
  assert.equal(
    looksLikeAuthFailure(observed, { minHints: 1 }),
    true,
    "the probe's own threshold has to catch the string that was actually observed"
  );
  // A signed-in model list must stay clean at the lower threshold too, otherwise the probe
  // would trade a false ready for a false not-ready. Captured from grok 0.2.117, 2026-07-31.
  assert.equal(
    looksLikeAuthFailure(
      "You are logged in with grok.com.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)",
      { minHints: 1 }
    ),
    false,
    "a real signed-in model list must not read as a denial"
  );
  // Nonsense thresholds fall back to the safe default rather than classifying everything.
  assert.equal(looksLikeAuthFailure(observed, { minHints: 0 }), false);
  assert.equal(looksLikeAuthFailure(observed, { minHints: "1" }), false);
});

test("check does not report ready when the models probe exits 0 but denies the session", () => {
  const binDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir, "models-exit-zero-denied");

  const result = run(process.execPath, [SCRIPT, "check", "--cwd", repo, "--json"], {
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() })
  });

  const report = JSON.parse(result.stdout);
  assert.equal(report.auth.loggedIn, false, "exit 0 is not proof of a session");
  assert.equal(report.ready, false, "ready is what the caller acts on; it must not lie");
  assert.match(
    report.auth.detail,
    /not authenticated/i,
    "the CLI's own wording has to reach the caller instead of being replaced by a guess"
  );
  assert.ok(
    report.nextSteps.some((step) => /Authenticate the Grok CLI/i.test(step)),
    "a not-ready check owes the caller the remedy"
  );
});

/**
 * The same exit-0 assumption sat one layer up, on the run path: `failureKind` was computed
 * only when the exit code was non-zero, and `hasDeliverable` accepted any non-empty stdout
 * on exit 0. Together those handed the CLI's own error text back as the answer, with
 * failureCode null and process exit 0 — a run that never happened, reported as a success.
 *
 * The pair below has to be read together. Loosening the gate is only safe because the
 * discriminator is the CLI's error ENVELOPE and not the words in the output: an agent
 * answer that discusses authentication carries the same hints and must still be delivered.
 */
test("an error envelope on exit 0 is a failure, not a deliverable", () => {
  const binDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir, "denied-exit-zero");

  const result = run(process.execPath, [SCRIPT, "run", "--cwd", repo, "--json", "say hello"], {
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() })
  });

  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "not-authenticated");
  assert.equal(payload.delivered, false, "the error text must not count as the answer");
});

test("an answer that merely discusses authentication is still delivered", () => {
  const binDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir, "auth-prose-answer");

  const result = run(process.execPath, [SCRIPT, "run", "--cwd", repo, "--json", "review auth"], {
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() })
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(
    result.status,
    0,
    "a delivered review must not be failed for quoting the words of a denial"
  );
  assert.equal(payload.failureCode, null);
  assert.equal(payload.delivered, true);
  assert.match(payload.text ?? payload.rawOutput ?? "", /looks correct/);
});

test("a review that quotes the denial envelope is still delivered", () => {
  // The self-inflicted case. This repository contains the signed-out envelope verbatim —
  // in lib/grok.mjs and in this fixture — so reviewing it through the bridge produces an
  // answer that embeds the envelope alongside the auth hints. Under a "an envelope appears
  // anywhere in stdout" rule, the bridge failed its own review as not-authenticated.
  const binDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir, "answer-quotes-envelope");

  const result = run(process.execPath, [SCRIPT, "run", "--cwd", repo, "--json", "review auth"], {
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: makeTempDir() })
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(result.status, 0, "quoting an error is not committing one");
  assert.equal(payload.failureCode, null);
  assert.equal(payload.delivered, true);
});

test("the redaction covers every pattern SECURITY.md promises, including a bare KEY=", () => {
  // SECURITY.md names four shapes: `sk-…`, `xai-…`, `Bearer …`, and `KEY=`/`TOKEN=`/
  // `SECRET=`. The last one was a promise the code did not keep: the alternation required
  // the literal `API` first, so a plain `KEY=` — the shortest spelling anyone actually
  // writes — passed through into durable logs. Four earlier audits could not catch it;
  // they had the documentation and not the source. Pinned here so the promise and the
  // implementation cannot drift apart again silently.
  const scrubbed = scrubSecrets(
    [
      "sk-abcdefgh12345678",
      "xai-abcdefgh12345678",
      "Authorization: Bearer abcdefgh12345678",
      "KEY=hunter2hunter2",
      "API_KEY=hunter2hunter2",
      "TOKEN=hunter2hunter2",
      "SECRET=hunter2hunter2",
      "PASSWORD=hunter2hunter2"
    ].join("\n")
  );

  assert.doesNotMatch(scrubbed, /hunter2/, "no assignment value may survive");
  assert.doesNotMatch(scrubbed, /abcdefgh12345678/, "no token-shaped string may survive");
  // The labels stay: a log that hides which setting was involved is harder to debug and
  // no safer.
  for (const label of ["KEY", "API_KEY", "TOKEN", "SECRET", "PASSWORD"]) {
    assert.ok(scrubbed.includes(`${label}=[REDACTED]`), `${label} must be named and redacted`);
  }
  // Ordinary prose must not be mangled — over-eager on assignments is fine, over-eager on
  // everything makes the logs useless.
  assert.equal(scrubSecrets("the run took 12 seconds"), "the run took 12 seconds");
});

test("a signed-out run reports not-authenticated and exit 2, not a generic CLI error", () => {
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeGrok(binDir, "not-signed-in");

  const result = run(process.execPath, [SCRIPT, "run", "--cwd", repo, "--json", "say hello"], {
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
  });

  // Exit 2 is the contract for "no deliverable, and the bridge knows why". Retrying an
  // unauthenticated client is as futile as retrying an exhausted allowance, which is the
  // other member of that set.
  assert.equal(result.status, 2, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureCode, "not-authenticated");
  assert.equal(payload.delivered, false);
  assert.match(
    payload.rawOutput,
    /grok login --device-code/,
    "the remedy the CLI offered has to survive to the caller"
  );
});
