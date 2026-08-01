/**
 * What the child process is allowed to inherit — and what it must not.
 *
 * SECURITY.md tells readers the child gets a filtered environment. A filter that passes
 * the two best-known Node code-injection levers is not one: `NODE_OPTIONS=--require x.js`
 * loads that file before anything else runs, and `NODE_PATH` redirects bare module
 * resolution. Both were on the allowlist, neither is needed to launch the CLI.
 *
 * The same audit pass earlier on 2026-07-31 removed `ANTHROPIC_`/`OPENAI_` from the prefix
 * list — other vendors' API keys reaching a process that talks to xAI — and walked past
 * these two. That is why this test names the whole class rather than one variable: the
 * failure mode is a list that grows back one convenient entry at a time.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeChildEnv } from "../plugins/grok-build/scripts/lib/process.mjs";

test("code-injection levers never reach the child", () => {
  const forwarded = sanitizeChildEnv({
    PATH: "/usr/bin",
    NODE_OPTIONS: "--require /tmp/attacker.js",
    NODE_PATH: "/tmp/attacker-modules",
    // Lower case too: Windows environment names are case-insensitive and the allowlist is
    // folded, so a check that only tried the upper-case spelling would prove nothing.
    node_options: "--require /tmp/attacker.js"
  });

  assert.equal(forwarded.NODE_OPTIONS, undefined);
  assert.equal(forwarded.NODE_PATH, undefined);
  assert.equal(forwarded.node_options, undefined);
  assert.equal(forwarded.PATH, "/usr/bin", "the child still needs to find its binary");
});

test("other vendors' credentials never reach the child either", () => {
  const forwarded = sanitizeChildEnv({
    PATH: "/usr/bin",
    XAI_API_KEY: "xai-keep-this",
    GROK_BINARY: "/opt/grok",
    ANTHROPIC_API_KEY: "sk-ant-not-this",
    OPENAI_API_KEY: "sk-not-this-either"
  });

  assert.equal(forwarded.ANTHROPIC_API_KEY, undefined);
  assert.equal(forwarded.OPENAI_API_KEY, undefined);
  // The vendor whose CLI we actually launch keeps its credentials.
  assert.equal(forwarded.XAI_API_KEY, "xai-keep-this");
  assert.equal(forwarded.GROK_BINARY, "/opt/grok");
});

test("nothing unlisted slips through", () => {
  const forwarded = sanitizeChildEnv({
    PATH: "/usr/bin",
    AWS_SECRET_ACCESS_KEY: "nope",
    GITHUB_TOKEN: "nope",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    LD_PRELOAD: "/tmp/evil.so"
  });

  for (const key of ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "LD_PRELOAD"]) {
    assert.equal(forwarded[key], undefined, `${key} must not be forwarded`);
  }
});
