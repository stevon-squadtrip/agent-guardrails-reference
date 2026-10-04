// The fake service behaves like the README says, including printing the
// result lines that preconditions depend on.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'example-infra', 'infractl.mjs');
let stateDir;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infractl-'));
});

function infractl(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, INFRACTL_STATE_DIR: stateDir } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('prod deploys go to standby by default', () => {
  const r = infractl('deploy', '--env', 'prod', '--build', '42');
  assert.equal(r.code, 0);
  assert.match(r.out, /^\[infractl\] action=deploy env=prod slot=standby build=42$/m);
  assert.match(infractl('status', '--env', 'prod').out, /live=build 41 {2}standby=build 42/);
});

test('health exits 1 and says unhealthy for a bad build', () => {
  infractl('deploy', '--env', 'prod', '--build', '43');
  const r = infractl('health', '--env', 'prod', '--slot', 'standby');
  assert.equal(r.code, 1);
  assert.match(r.out, /result=unhealthy/);
});

test('swap exchanges the slots, and swapping again rolls back', () => {
  infractl('deploy', '--env', 'prod', '--build', '42');
  infractl('swap', '--env', 'prod');
  assert.match(infractl('status', '--env', 'prod').out, /live=build 42 {2}standby=build 41/);
  infractl('swap', '--env', 'prod');
  assert.match(infractl('status', '--env', 'prod').out, /live=build 41 {2}standby=build 42/);
});

test('snapshot then restore brings back the old config', () => {
  const snap = infractl('config', 'snapshot', '--env', 'prod').out.match(/id=(\S+)/)[1];
  infractl('config', 'set', '--env', 'prod', 'MAX_CONNECTIONS=200');
  assert.match(infractl('config', 'get', '--env', 'prod', 'MAX_CONNECTIONS').out, /=200/);
  infractl('config', 'restore', '--env', 'prod', '--snapshot', snap);
  assert.match(infractl('config', 'get', '--env', 'prod', 'MAX_CONNECTIONS').out, /=100/);
});

test('rotating a secret bumps its version', () => {
  assert.match(infractl('secrets', 'rotate', '--env', 'prod', 'API_SIGNING_KEY').out, /version 7 revoked, version 8 active/);
});

test('a destroyed environment refuses commands until re-created', () => {
  infractl('env', 'destroy', '--env', 'staging');
  assert.equal(infractl('logs', '--env', 'staging').code, 2);
  assert.equal(infractl('env', 'create', '--env', 'staging').code, 0);
  assert.equal(infractl('logs', '--env', 'staging').code, 0);
});

test('unknown flags are rejected, so the guard and the CLI agree on spelling', () => {
  const r = infractl('swap', '-e', 'prod');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown flag -e/);
});

test('writes without --env are rejected', () => {
  assert.equal(infractl('swap').code, 2);
});
