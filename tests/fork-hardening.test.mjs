import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import {
  extractLastJsonObject,
  looksLikeEnvelope,
  runHeadlessAgent,
  scanJsonObjects
} from "../plugins/grok-build/scripts/lib/grok.mjs";
import {
  acquireGlobalSlot,
  acquireThreadLock,
  assertValidThreadName,
  getNamedThread,
  resolveStateDir,
  resolveStateRoot,
  setNamedThread,
  withStateLock
} from "../plugins/grok-build/scripts/lib/state.mjs";
import {
  isProcessGone,
  resolveExecutable,
  toSpawnTarget
} from "../plugins/grok-build/scripts/lib/process.mjs";

/** A pid that process.kill(pid, 0) reports as gone (ESRCH). */
function findDeadPid() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], {
    stdio: "ignore",
    detached: true,
    windowsHide: true
  });
  child.unref();
  const pid = child.pid;
  assert.ok(pid > 0);
  if (process.platform === "win32") {
    run("taskkill", ["/PID", String(pid), "/F", "/T"]);
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // The production predicate, deliberately. A killed child stays in the process table
    // as a zombie until its parent reaps it, and this loop blocks the event loop — so the
    // parent, which is this very process, never gets the chance. `kill(pid, 0)` on a
    // corpse SUCCEEDS, so the bare signal check reported the child alive for the full
    // five seconds and this helper threw. Measured under WSL2 on 2026-07-31: /proc state
    // stayed `Z` for as long as the loop blocked, and flipped to gone within 50 ms as
    // soon as the loop was allowed to breathe.
    if (isProcessGone(pid)) {
      return pid;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error(`pid ${pid} did not die in time`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    // Must await: restoring the env synchronously would move async work back onto the
    // developer's real state root (and silently invalidate the assertions).
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("scanJsonObjects recovers the final object from concatenated schema messages", () => {
  // Schema-constrained runs emit one object per assistant message; a plain JSON.parse
  // of the whole text fails even though the final answer is present.
  const text = '{"overall":"starting","findings":[]}{"overall":"working","findings":[]}{"overall":"done","findings":[{"id":1}]}';
  const objects = scanJsonObjects(text);
  assert.equal(objects.length, 3);
  const last = extractLastJsonObject(text);
  assert.equal(last.overall, "done");
  assert.equal(last.findings.length, 1);
});

test("scanJsonObjects ignores braces inside strings and tolerates surrounding prose", () => {
  const text = 'Narration first. {"note":"a } brace \\" in a string","ok":true} trailing words';
  const last = extractLastJsonObject(text);
  assert.deepEqual(last, { note: 'a } brace " in a string', ok: true });
  assert.equal(extractLastJsonObject("no json here"), null);
});

test("thread names reject prototype-poisoning and path-unsafe values", () => {
  assert.equal(assertValidThreadName("review-1"), "review-1");
  for (const bad of ["__proto__", "constructor", "../escape", "with space", "", "a/b"]) {
    assert.throws(() => assertValidThreadName(bad), /Invalid thread name/);
  }
});

test("named threads round-trip and a corrupt registry is surfaced, not ignored", async () => {
  await withPluginData(() => {
    const workspace = makeTempDir();
    assert.equal(getNamedThread(workspace, "alpha"), null);
    setNamedThread(workspace, "alpha", "session-alpha");
    assert.equal(getNamedThread(workspace, "alpha").sessionId, "session-alpha");

    const registry = path.join(process.env.CLAUDE_PLUGIN_DATA, "state");
    const dir = fs.readdirSync(registry).find((entry) => entry.includes("-"));
    fs.writeFileSync(path.join(registry, dir, "named-threads.json"), "{not json", "utf8");
    assert.throws(() => getNamedThread(workspace, "alpha"), /corrupt/i);
  });
});

test("a thread lock is exclusive and released", async () => {
  await withPluginData(() => {
    const workspace = makeTempDir();
    const first = acquireThreadLock(workspace, "busy");
    assert.ok(first);
    assert.equal(acquireThreadLock(workspace, "busy"), null, "second acquisition must not succeed");
    first.release();
    const third = acquireThreadLock(workspace, "busy");
    assert.ok(third, "lock must be reusable after release");
    third.release();
  });
});

test("state lock release is ownership-checked, so a stolen lock is not deleted twice", async () => {
  await withPluginData(() => {
    const workspace = makeTempDir();
    let lockPath = null;
    let foreignToken = null;

    withStateLock(workspace, () => {
      const stateDir = path.join(
        process.env.CLAUDE_PLUGIN_DATA,
        "state",
        fs.readdirSync(path.join(process.env.CLAUDE_PLUGIN_DATA, "state"))[0]
      );
      lockPath = path.join(stateDir, "state.json.lock");
      assert.equal(fs.existsSync(lockPath), true);
      // Simulate a steal: another process replaces the lock while we hold it.
      foreignToken = "999999:foreign";
      fs.writeFileSync(lockPath, foreignToken, "utf8");
    });

    // Our release must have left the foreign lock untouched.
    assert.equal(fs.readFileSync(lockPath, "utf8"), foreignToken);
  });
});

test("GROK_CC_MAX_CONCURRENCY=0 removes the bound entirely", async () => {
  await withPluginData(async () => {
    const previous = process.env.GROK_CC_MAX_CONCURRENCY;
    process.env.GROK_CC_MAX_CONCURRENCY = "0";
    try {
      const handles = [];
      for (let i = 0; i < 5; i += 1) {
        handles.push(await acquireGlobalSlot({ waitMs: 500 }));
      }
      assert.equal(handles.every((h) => h.unbounded === true), true, "no slot may be taken when unbounded");
      handles.forEach((h) => h.release());
    } finally {
      if (previous === undefined) {
        delete process.env.GROK_CC_MAX_CONCURRENCY;
      } else {
        process.env.GROK_CC_MAX_CONCURRENCY = previous;
      }
    }
  });
});

test("global slots cap concurrency, queue, and never fail a run", async () => {
  await withPluginData(async () => {
    const first = await acquireGlobalSlot({ maxSlots: 1, waitMs: 500 });
    assert.equal(first.slot, 1);

    // While the cap is reached the next caller waits...
    let overflowed = 0;
    const queued = await acquireGlobalSlot({
      maxSlots: 1,
      waitMs: 500,
      onOverflow: () => {
        overflowed += 1;
      }
    });
    // ...and once the wait is exhausted it proceeds anyway instead of throwing:
    // a caller must be able to offload without tracking what else is running.
    assert.equal(queued.overflow, true);
    assert.equal(overflowed, 1);
    queued.release();

    first.release();
    const afterRelease = await acquireGlobalSlot({ maxSlots: 1, waitMs: 500 });
    assert.equal(afterRelease.slot, 1, "a freed slot is handed to the next caller");
    assert.equal(afterRelease.overflow, undefined);
    afterRelease.release();
  });
});

test("global slot wait-then-release hands a real slot without overflow", async () => {
  await withPluginData(async () => {
    const first = await acquireGlobalSlot({ maxSlots: 1, waitMs: 5000 });
    assert.equal(first.slot, 1);

    let overflowed = 0;
    const secondPromise = acquireGlobalSlot({
      maxSlots: 1,
      waitMs: 5000,
      onOverflow: () => {
        overflowed += 1;
      }
    });
    // Let the waiter enter the poll loop before freeing the held slot.
    await sleep(400);
    first.release();

    const second = await secondPromise;
    assert.equal(second.overflow, undefined, "waiter must receive a real slot after release");
    assert.equal(overflowed, 0);
    assert.equal(second.slot, 1);
    second.release();
  });
});

test("dead-pid global slot files are reclaimed immediately", async () => {
  await withPluginData(async () => {
    const deadPid = findDeadPid();
    const slotsDir = path.join(resolveStateRoot(), "global-slots");
    fs.mkdirSync(slotsDir, { recursive: true });
    const slotPath = path.join(slotsDir, "slot-1");
    fs.writeFileSync(slotPath, `${deadPid}:dead-holder`, "utf8");

    const handle = await acquireGlobalSlot({ maxSlots: 1, waitMs: 2000 });
    assert.equal(handle.slot, 1, "dead holder must free slot-1 for the next caller");
    assert.equal(handle.overflow, undefined);
    handle.release();
  });
});

test("global slot release is ownership-checked against a foreign token", async () => {
  await withPluginData(async () => {
    const handle = await acquireGlobalSlot({ maxSlots: 1, waitMs: 500 });
    assert.equal(handle.slot, 1);
    const slotPath = path.join(resolveStateRoot(), "global-slots", "slot-1");
    const foreignToken = "999999:foreign-slot";
    fs.writeFileSync(slotPath, foreignToken, "utf8");

    handle.release();
    assert.equal(
      fs.readFileSync(slotPath, "utf8"),
      foreignToken,
      "release must not delete a slot another process now owns"
    );
    fs.unlinkSync(slotPath);
  });
});

test("dead-pid thread locks are reclaimed so a new holder can acquire", async () => {
  await withPluginData(() => {
    const workspace = makeTempDir();
    const deadPid = findDeadPid();
    const stateDir = resolveStateDir(workspace);
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "thread-recover.lock");
    fs.writeFileSync(lockPath, `${deadPid}:dead-thread`, "utf8");

    const lock = acquireThreadLock(workspace, "recover");
    assert.ok(lock, "dead-pid thread lock must be reclaimable");
    assert.equal(acquireThreadLock(workspace, "recover"), null, "live reclaim holder still exclusive");
    lock.release();
  });
});

test("a live lock holder is never evicted by age, only a dead one is", async () => {
  await withPluginData(() => {
    const workspace = makeTempDir();
    const stateRoot = path.join(process.env.CLAUDE_PLUGIN_DATA, "state");
    // Seed a FRESH lock owned by THIS (alive) process.
    withStateLock(workspace, () => {});
    const stateDir = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
    const lockPath = path.join(stateDir, "state.json.lock");
    fs.writeFileSync(lockPath, `${process.pid}:live-holder`, "utf8");

    assert.throws(
      () => withStateLock(workspace, () => {}, { deadlineMs: 400 }),
      /Timed out acquiring state lock/
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid}:live-holder`, "live holder's lock must survive");

    // A lock with no identifiable owner and an ancient mtime IS reclaimable.
    const ancient = new Date(Date.now() - 60 * 60 * 1000);
    fs.writeFileSync(lockPath, "", "utf8");
    fs.utimesSync(lockPath, ancient, ancient);
    let entered = false;
    withStateLock(workspace, () => {
      entered = true;
    });
    assert.equal(entered, true, "orphaned lock must be reclaimable");

    // A lock whose pid still resolves but is ancient must ALSO be reclaimable: after a
    // hard kill the pid can be recycled by an unrelated process, and without this
    // ceiling the workspace would be wedged forever.
    fs.writeFileSync(lockPath, `${process.pid}:recycled-pid`, "utf8");
    fs.utimesSync(lockPath, ancient, ancient);
    let recovered = false;
    withStateLock(workspace, () => {
      recovered = true;
    });
    assert.equal(recovered, true, "a stale lock held by a recycled pid must self-heal");
  });
});

test("extractLastJsonObject takes the last object in a multi-object stream", () => {
  const schemaObject = '{"text":"model wrote this key itself","findings":[]}';
  const envelope = `{"text":"real answer","stopReason":"EndTurn","sessionId":"s1","num_turns":2}`;
  // Schema object appears AFTER the envelope in the stream; the last scanner result is the schema.
  const last = extractLastJsonObject(`${envelope}${schemaObject}`);
  assert.equal(last.text, "model wrote this key itself", "extractLastJsonObject takes the last object");
  const objects = scanJsonObjects(`${envelope}${schemaObject}`);
  assert.equal(objects.length, 2);
});

test("parseCliEnvelope prefers a real envelope over a later schema object with a text key", async () => {
  // parseCliEnvelope is not exported; drive it through runHeadlessAgent's json path.
  const binDir = makeTempDir();
  installFakeGrok(binDir, "multi-object-stream");
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, {
    prompt: "stream order",
    env,
    outputFormat: "json",
    globalSlot: false
  });

  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "real answer from envelope");
  assert.equal(result.envelopeHasText, true);
  assert.equal(result.envelopeParsed, true);
  assert.equal(result.parsed?.stopReason, "EndTurn");
  assert.deepEqual(result.structuredOutput, { verdict: "approve", findings: [] });
  assert.notEqual(result.finalMessage, "model wrote this key itself");
});

test("parseCliEnvelope does not treat a bare {text} object as a CLI envelope", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "bare-text-object");
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, {
    prompt: "bare object",
    env,
    outputFormat: "json",
    globalSlot: false
  });

  assert.equal(result.status, 0);
  // Bare {text} fails looksLikeEnvelope (no stopReason/sessionId/usage). The fallback
  // still surfaces the last object, but without envelope metadata fields.
  assert.equal(result.finalMessage, "bare text object not envelope");
  assert.equal(result.parsed?.stopReason, undefined);
  assert.equal(result.cliSessionId, null);
  assert.equal(result.numTurns, null);
  assert.equal(result.usage, null);
  assert.equal(result.structuredOutput, null);
});

test("looksLikeEnvelope rejects model JSON with text+usage; accepts real CLI envelopes", () => {
  // Model output can carry text and token usage; that must not be treated as the CLI envelope.
  assert.equal(
    looksLikeEnvelope({
      text: "model wrote this",
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      sessionId: "model-session"
    }),
    false
  );
  assert.equal(
    looksLikeEnvelope({
      text: "model wrote this",
      usage: { total_tokens: 3 }
    }),
    false
  );
  // Real CLI envelope: stopReason + session identity (sessionId and/or num_turns).
  assert.equal(
    looksLikeEnvelope({
      text: "real answer",
      stopReason: "EndTurn",
      sessionId: "s1",
      num_turns: 2,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }),
    true
  );
  assert.equal(
    looksLikeEnvelope({
      text: "",
      stopReason: "EndTurn",
      sessionId: "s1",
      num_turns: 1
    }),
    true
  );
  // stopReason + usage alone is too weak (no session identity).
  assert.equal(
    looksLikeEnvelope({
      text: "x",
      stopReason: "EndTurn",
      usage: { total_tokens: 1 }
    }),
    false
  );
});

test("parseCliEnvelope does not treat text+usage model JSON as a CLI envelope", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "text-plus-usage-object");
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, {
    prompt: "model shaped",
    env,
    outputFormat: "json",
    globalSlot: false
  });

  assert.equal(result.status, 0);
  // Not an envelope: finalMessage falls back to raw stdout (stringified object), not envelope.text alone
  // with envelope metadata attached.
  assert.equal(result.cliSessionId, null);
  assert.equal(result.numTurns, null);
  assert.equal(result.stopReason, null);
  assert.equal(result.structuredOutput, null);
  assert.match(result.finalMessage, /model text with usage field/);
});

test("runHeadlessAgent reuses an external slot without acquiring a second under maxSlots=1", async () => {
  await withPluginData(async () => {
    const held = await acquireGlobalSlot({ maxSlots: 1, waitMs: 500 });
    assert.equal(held.slot, 1);
    const slotPath = path.join(resolveStateRoot(), "global-slots", "slot-1");
    const tokenBefore = fs.readFileSync(slotPath, "utf8");

    const binDir = makeTempDir();
    installFakeGrok(binDir, "empty-then-ok");
    const env = buildEnv(binDir);
    const cwd = makeTempDir();

    const first = await runHeadlessAgent(cwd, {
      prompt: "empty first",
      env,
      outputFormat: "json",
      slot: held
    });
    assert.equal(first.finalMessage, "");
    assert.equal(fs.readFileSync(slotPath, "utf8"), tokenBefore, "external slot must stay held across run 1");

    const second = await runHeadlessAgent(cwd, {
      prompt: "nudge",
      resumeSessionId: first.sessionId,
      env,
      outputFormat: "json",
      slot: held
    });
    assert.match(second.finalMessage, /Recovered after empty first turn/);
    assert.equal(fs.readFileSync(slotPath, "utf8"), tokenBefore, "external slot must stay held across nudge");
    held.release();
    assert.equal(fs.existsSync(slotPath), false);
  });
});

test("script entry points are launched through node, not a shell", () => {
  const target = toSpawnTarget("C:/tmp/grok-fake.mjs", ["-p", "hi"]);
  assert.equal(target.viaNode, true);
  assert.equal(target.command, process.execPath);
  assert.deepEqual(target.args, ["C:/tmp/grok-fake.mjs", "-p", "hi"]);

  const plain = toSpawnTarget("grok", ["--version"]);
  assert.equal(plain.viaNode, false);
  assert.equal(plain.command, "grok");
});

test("resolveExecutable prefers a PATHEXT match and declines extensionless files", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific resolution");
    return;
  }
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "tool.exe"), "binary", "utf8");
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(resolveExecutable("tool", env), path.join(dir, "tool.exe"));

  const scriptDir = makeTempDir();
  fs.writeFileSync(path.join(scriptDir, "shim"), "#!/usr/bin/env node", "utf8");
  // Extensionless earlier in PATH must not silently fall through to a later .exe.
  assert.equal(resolveExecutable("shim", { PATH: `${scriptDir};${dir}`, PATHEXT: ".EXE" }), null);
});
