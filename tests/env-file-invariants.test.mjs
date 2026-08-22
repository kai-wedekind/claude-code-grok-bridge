/**
 * Gates for env-file invariants that had no coverage (docs/env-file-invariants.md).
 *
 * The coverage table in that document listed F1, A2b, A3, A4 and A10 as ungated. Each test
 * here is named for the invariant it pins. Content comparison alone cannot gate F1 — a rewrite
 * that produces identical bytes is invisible to it — so that one counts writes.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  appendEnvVar,
  handleSessionStart
} from "../plugins/grok-build/scripts/session-lifecycle-hook.mjs";
import { makeTempDir } from "./helpers.mjs";

function withEnvFile(seed, run) {
  const dir = makeTempDir();
  const file = path.join(dir, "env");
  fs.writeFileSync(file, seed, "utf8");
  const previous = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = file;
  try {
    return run(file);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previous;
    }
  }
}

test("F1: an event that changes nothing performs no write", () => {
  // Content comparison cannot gate this: a rewrite that produces identical bytes is invisible
  // to it. Count the writes. Positive control first, then the no-op second event.
  withEnvFile("", (file) => {
    const realWrite = fs.writeFileSync;
    let count = 0;
    fs.writeFileSync = (target, data, options) => {
      if (String(target) === file) {
        count += 1;
      }
      return realWrite(target, data, options);
    };
    try {
      appendEnvVar("CLAUDE_SESSION_ID", "abc123");
      assert.equal(count, 1, "positive control: the first event with new content must write");
      const afterFirst = count;
      appendEnvVar("CLAUDE_SESSION_ID", "abc123");
      assert.equal(
        count,
        afterFirst,
        "F1: a second event with identical values must not call writeFileSync"
      );
    } finally {
      fs.writeFileSync = realWrite;
    }
  });
});

test("A2b: a foreign line that was after our block stays after it", () => {
  // Seed a foreign line, run an event (our block lands after it), append a second foreign line
  // after the block, run another event that must rewrite, and assert the second foreign line's
  // index is still greater than the block's. The previous implementation appended the owned
  // block at the end, which silently moved that second foreign line in front of ours.
  withEnvFile("FOREIGN_BEFORE=keep\n", (file) => {
    appendEnvVar("CLAUDE_SESSION_ID", "first");

    const afterFirst = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, `${afterFirst}FOREIGN_AFTER=keep\n`, "utf8");

    // Force a real rewrite — same value would hit F1 and leave the file untouched, which would
    // pass this test for the wrong reason.
    appendEnvVar("CLAUDE_SESSION_ID", "second");

    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const blockIdx = lines.findIndex(
      (line) =>
        line.startsWith("CLAUDE_SESSION_ID=") || line.startsWith("export CLAUDE_SESSION_ID=")
    );
    const afterIdx = lines.findIndex((line) => line.startsWith("FOREIGN_AFTER="));
    assert.ok(blockIdx !== -1, "our block must be present");
    assert.ok(afterIdx !== -1, "the second foreign line must still be present");
    assert.ok(
      afterIdx > blockIdx,
      `A2b: FOREIGN_AFTER must stay after our block; block at ${blockIdx}, after at ${afterIdx}; file was ${JSON.stringify(lines)}`
    );
  });
});

test("A4: a value containing a newline leaves no fragment", () => {
  // The writer collapses newlines so a multi-line value re-parses as one binding. Without that,
  // fragments become top-level lines, land outside the quotes, and reintroduce A3.
  withEnvFile("", (file) => {
    const value = "line-one\nline-two\nline-three";
    for (let i = 0; i < 5; i += 1) {
      appendEnvVar("CLAUDE_SESSION_ID", value);
    }

    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    for (const line of lines) {
      assert.ok(
        line.startsWith("CLAUDE_SESSION_ID=") || line.startsWith("export CLAUDE_SESSION_ID="),
        `A4: unexpected top-level line (a newline fragment): ${JSON.stringify(line)}`
      );
    }

    const lengthAfter = Buffer.byteLength(content, "utf8");
    appendEnvVar("CLAUDE_SESSION_ID", value);
    appendEnvVar("CLAUDE_SESSION_ID", value);
    assert.equal(
      Buffer.byteLength(fs.readFileSync(file, "utf8"), "utf8"),
      lengthAfter,
      "A4: further events with the same multi-line value must not grow the file"
    );
  });
});

test("A3: repeated events do not grow the file", () => {
  withEnvFile("FOREIGN=keep\n", (file) => {
    const unchanged = [];
    for (let i = 0; i < 12; i += 1) {
      appendEnvVar("CLAUDE_SESSION_ID", "stable-value");
      unchanged.push(fs.statSync(file).size);
    }
    const steadyUnchanged = unchanged[0];
    for (const size of unchanged) {
      assert.equal(
        size,
        steadyUnchanged,
        "A3: N events with unchanged values must reach a steady byte length"
      );
    }

    // Fixed-width values so a legitimate value change cannot look like unbounded growth.
    const changed = [];
    for (let i = 0; i < 12; i += 1) {
      appendEnvVar("CLAUDE_SESSION_ID", `v${String(i).padStart(3, "0")}`);
      changed.push(fs.statSync(file).size);
    }
    const steadyChanged = changed[0];
    for (const size of changed) {
      assert.equal(
        size,
        steadyChanged,
        "A3: N events with changed values must not climb; rewrite replaces, it does not append"
      );
    }
  });
});

test("A10: both variables land in one write", async () => {
  // Drive handleSessionStart, not writeEnvVars directly: A10 is the caller's contract that
  // every owned variable for the event goes out in one read-modify-write. Two separate
  // appendEnvVar calls would produce two writeFileSync calls and a window where one variable
  // is new and the other is old.
  //
  // ⚠ Do not route this through a sync withEnvFile(async …) helper. The helper returns the
  // promise without the test awaiting it, so the assertions run after the test is already
  // marked passed — failures become unhandledRejections and greens assert nothing in time.
  // That is the fifth vacuous shape the invariant doc warned about.
  const dir = makeTempDir();
  const file = path.join(dir, "env");
  fs.writeFileSync(file, "", "utf8");
  const previousEnv = process.env.CLAUDE_ENV_FILE;
  const previousPlugin = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_ENV_FILE = file;
  process.env.CLAUDE_PLUGIN_DATA = "C:/state/root";
  const realWrite = fs.writeFileSync;
  let writeCount = 0;
  fs.writeFileSync = (target, data, options) => {
    if (String(target) === file) {
      writeCount += 1;
    }
    return realWrite(target, data, options);
  };
  try {
    // source "resume" skips the update-notice path so only the env write is counted.
    await handleSessionStart({ session_id: "sess-abc", source: "resume" });
    assert.equal(
      writeCount,
      1,
      "A10: handleSessionStart must write the env file exactly once"
    );
    const content = fs.readFileSync(file, "utf8");
    assert.match(content, /GROK_CC_SESSION_ID/, "session id must be present after the one write");
    assert.match(content, /CLAUDE_PLUGIN_DATA/, "plugin data must be present after the one write");
  } finally {
    fs.writeFileSync = realWrite;
    if (previousEnv === undefined) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previousEnv;
    }
    if (previousPlugin === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPlugin;
    }
  }
});
