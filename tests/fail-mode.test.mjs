// What happens when the guard itself breaks. See "Fail open or fail closed"
// in the README.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluate, POLICIES } from '../.claude/hooks/lib/engine.mjs';
import { readEntries } from '../.claude/hooks/lib/audit.mjs';
import { bash, makeCtx, INFRA } from './helpers.mjs';

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'hooks', 'guard.mjs');
const broken = { name: 'broken', check() { throw new Error('typo in policy'); } };

test('fail open: a throwing policy is skipped and reported, the call is allowed', () => {
  const r = evaluate(bash('ls'), makeCtx(), [broken]);
  assert.equal(r.decision, 'allow');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /typo in policy/);
});

test('fail open: the other policies still run', () => {
  const r = evaluate(bash(`${INFRA} env destroy --env prod`), makeCtx(), [broken, ...POLICIES]);
  assert.equal(r.decision, 'deny');
  assert.deepEqual(r.policies, ['infra-actions']);
});

test('fail closed: a throwing policy denies the call', () => {
  const r = evaluate(bash('ls'), makeCtx({ failMode: 'closed' }), [broken]);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /GUARD_FAIL_MODE=closed/);
});

function runGuard(stdin, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fail-'));
  const env = { ...process.env, GUARD_AUDIT_FILE: path.join(dir, 'audit.jsonl'), GUARD_STATE_DIR: dir, ...extraEnv };
  delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync(process.execPath, [GUARD], { input: stdin, encoding: 'utf8', env });
  const entries = readEntries(env.GUARD_AUDIT_FILE);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, entries };
}

test('hook process: malformed input fails open with exit 0 and a logged guard_error', () => {
  const r = runGuard('{not json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].event, 'guard_error');
});

test('hook process: malformed input with GUARD_FAIL_MODE=closed denies', () => {
  const r = runGuard('{not json', { GUARD_FAIL_MODE: 'closed' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('hook process: an allowed call prints nothing (never an explicit allow)', () => {
  const r = runGuard(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.entries.at(-1).decision, 'allow');
});

test('hook process: a deny is printed in the format Claude Code reads', () => {
  const r = runGuard(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command: `${INFRA} env destroy --env prod` } }));
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /never done from an agent session/);
});

test('hook process: an unwritable audit log does not change the decision', () => {
  const r = runGuard(
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command: `${INFRA} env destroy --env prod` } }),
    { GUARD_AUDIT_FILE: path.join(GUARD, 'not-a-dir', 'audit.jsonl') },
  );
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.stderr, /could not write audit log/);
});
