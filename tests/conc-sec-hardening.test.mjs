import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { makeTempDir, run } from './helpers.mjs';
import {
  acquireThreadLock,
  assertValidSessionId,
  claimJobTerminal,
  listJobs,
  resolveJobLogFile,
  resolveStateDir,
  setNamedThread,
  getNamedThread,
  upsertJob,
  writeJobFile
} from '../plugins/grok-build/scripts/lib/state.mjs';
import {
  appendLogLine,
  resolveJobKillTargets
} from '../plugins/grok-build/scripts/lib/tracked-jobs.mjs';
import {
  buildStatusSnapshot,
  reclaimOrphanedJob
} from '../plugins/grok-build/scripts/lib/job-control.mjs';
import { isProcessGone } from '../plugins/grok-build/scripts/lib/process.mjs';

function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

function findDeadPid() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 60000)'], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true
  });
  child.unref();
  const pid = child.pid;
  assert.ok(pid > 0);
  if (process.platform === 'win32') {
    run('taskkill', ['/PID', String(pid), '/F', '/T']);
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // Same reason as the twin helper in fork-hardening: this loop blocks the event loop,
    // so the killed child is never reaped and stays a zombie whose pid `kill(pid, 0)`
    // still answers for. isProcessGone knows the difference; a bare signal check does not.
    if (isProcessGone(pid)) return pid;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error('pid did not die');
}

test('reclaimOrphanedJob claims failed when all kill-target PIDs are gone', () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const deadPid = findDeadPid();
    const jobId = 'job-orphan-1';
    const running = {
      id: jobId,
      status: 'running',
      phase: 'running',
      title: 'Orphan',
      bridgePid: deadPid,
      agentPid: deadPid,
      pid: deadPid
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const reclaimed = reclaimOrphanedJob(workspace, running);
    assert.equal(reclaimed.status, 'failed');
    assert.match(reclaimed.errorMessage || '', /Orphaned/i);

    const jobs = listJobs(workspace);
    assert.equal(jobs.find((j) => j.id === jobId)?.status, 'failed');
  });
});

test('buildStatusSnapshot reaps orphaned running jobs', () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const deadPid = findDeadPid();
    const jobId = 'job-orphan-status';
    const running = {
      id: jobId,
      status: 'running',
      phase: 'running',
      title: 'OrphanStatus',
      bridgePid: deadPid,
      pid: deadPid,
      sessionId: process.env.GROK_CC_SESSION_ID
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const snapshot = buildStatusSnapshot(workspace);
    assert.equal(snapshot.running.some((j) => j.id === jobId), false);
    const finished =
      snapshot.latestFinished?.id === jobId
        ? snapshot.latestFinished
        : snapshot.recent.find((j) => j.id === jobId);
    assert.ok(finished);
    assert.equal(finished.status, 'failed');
  });
});

test('reclaimOrphanedJob leaves live PIDs alone', () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = 'job-live';
    const running = {
      id: jobId,
      status: 'running',
      phase: 'running',
      title: 'Live',
      bridgePid: process.pid,
      pid: process.pid
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);
    const same = reclaimOrphanedJob(workspace, running);
    assert.equal(same.status, 'running');
  });
});

test('assertValidSessionId rejects path-like and empty values', () => {
  assert.equal(assertValidSessionId('abc-123'), 'abc-123');
  assert.equal(assertValidSessionId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  for (const bad of ['', '../x', 'a/b', 'a\\\\b', ' has space', 'x'.repeat(200)]) {
    assert.throws(() => assertValidSessionId(bad), /Invalid session id/);
  }
});

test('setNamedThread validates sessionId; getNamedThread ignores tampered ids', () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    setNamedThread(workspace, 't1', 'session-ok-1');
    assert.equal(getNamedThread(workspace, 't1').sessionId, 'session-ok-1');
    assert.throws(() => setNamedThread(workspace, 't1', '../evil'), /Invalid session id/);

    // Tamper the registry directly.
    const stateDir = resolveStateDir(workspace);
    const registryPath = path.join(stateDir, 'named-threads.json');
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ t1: { sessionId: '../evil', updatedAt: new Date().toISOString() } }, null, 2),
      'utf8'
    );
    assert.equal(getNamedThread(workspace, 't1'), null);
  });
});

test('appendLogLine scrubs secret-shaped tokens', () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const logFile = resolveJobLogFile(workspace, 'job-scrub');
    fs.writeFileSync(logFile, '', 'utf8');
    appendLogLine(logFile, 'token sk-abc123456789 and Bearer supersecrettokenvalue');
    const body = fs.readFileSync(logFile, 'utf8');
    assert.match(body, /sk-\[REDACTED\]/);
    assert.match(body, /Bearer \[REDACTED\]/);
    assert.doesNotMatch(body, /sk-abc123456789/);
    assert.doesNotMatch(body, /supersecrettokenvalue/);
  });
});

test('thread lock never returns ownership without a written token', () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const first = acquireThreadLock(workspace, 'tok');
    assert.ok(first);
    const stateDir = resolveStateDir(workspace);
    const lockPath = path.join(stateDir, 'thread-tok.lock');
    const token = fs.readFileSync(lockPath, 'utf8').trim();
    assert.match(token, /^\d+:[0-9a-f-]+$/i);
    first.release();
    assert.equal(fs.existsSync(lockPath), false);
  });
});
