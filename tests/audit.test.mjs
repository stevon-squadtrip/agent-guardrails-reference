import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { append, verify, readEntries, GENESIS } from '../.claude/hooks/lib/audit.mjs';
import { redact } from '../.claude/hooks/lib/redact.mjs';
import { summarizeInput } from '../.claude/hooks/lib/engine.mjs';
import { tool } from './helpers.mjs';

function freshLog(n = 5) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  for (let i = 0; i < n; i++) append(file, { event: 'pre', n: i });
  return file;
}

const lines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const write = (file, ls) => fs.writeFileSync(file, ls.map(l => `${l}\n`).join(''));

test('entries link to the previous hash, starting from genesis', () => {
  const entries = readEntries(freshLog(3));
  assert.equal(entries[0].prev, GENESIS);
  assert.equal(entries[1].prev, entries[0].hash);
  assert.equal(entries[2].prev, entries[1].hash);
});

test('an untouched log verifies', () => {
  assert.deepEqual(verify(freshLog()), { ok: true, entries: 5, brokenAt: null, problem: null });
});

test('an edited line is detected', () => {
  const file = freshLog();
  const ls = lines(file);
  ls[2] = ls[2].replace('"n":2', '"n":99');
  write(file, ls);
  const r = verify(file);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 3);
  assert.match(r.problem, /edited/);
});

test('a removed line in the middle is detected', () => {
  const file = freshLog();
  const ls = lines(file);
  ls.splice(1, 1);
  write(file, ls);
  assert.equal(verify(file).brokenAt, 2);
});

test('reordered lines are detected', () => {
  const file = freshLog();
  const ls = lines(file);
  [ls[1], ls[2]] = [ls[2], ls[1]];
  write(file, ls);
  assert.equal(verify(file).ok, false);
});

test('an edited line with a recomputed hash is still detected by the next line', () => {
  const file = freshLog();
  const ls = lines(file).map(l => JSON.parse(l));
  const { hash, ...body } = ls[1];
  body.n = 99;
  ls[1] = { ...body, hash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  write(file, ls.map(e => JSON.stringify(e)));
  assert.equal(verify(file).brokenAt, 3);
});

// Documents a limit stated in the README.
test('LIMIT: lines cut off the end are not detected', () => {
  const file = freshLog();
  write(file, lines(file).slice(0, 3));
  assert.equal(verify(file).ok, true);
});

test('LIMIT: a log rewritten from scratch is not detected', () => {
  const file = freshLog();
  fs.rmSync(file);
  append(file, { event: 'pre', n: 0 });
  assert.equal(verify(file).ok, true);
});

test('redaction masks common secret shapes', () => {
  const cases = [
    ['API_SIGNING_KEY=abc123def', 'API_SIGNING_KEY=[REDACTED]'],
    ['export DB_PASSWORD="hunter two"', 'export DB_PASSWORD=[REDACTED]'],
    ['curl -H "Authorization: Bearer eyJhbGciOi.payload.sig"', 'curl -H "Authorization: Bearer [REDACTED]'],
    ['token: ghp_0123456789abcdefABCDEF', 'token: [REDACTED]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', '[REDACTED PRIVATE KEY]'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('redaction leaves ordinary commands alone', () => {
  const cmd = 'node example-infra/infractl.mjs config set --env prod MAX_CONNECTIONS=200';
  assert.equal(redact(cmd), cmd);
});

test('the log stores file paths and sizes, never file contents', () => {
  const summary = summarizeInput(tool('Write', { file_path: 'config/.env', content: 'API_SIGNING_KEY=real' }));
  assert.deepEqual(summary, { file_path: 'config/.env', bytes: 20 });
});

test('concurrent appends from separate processes keep one unbroken chain', async () => {
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-race-'));
  const file = path.join(dir, 'audit.jsonl');
  const auditUrl = new URL('../.claude/hooks/lib/audit.mjs', import.meta.url).href;
  const script = `const a = await import(${JSON.stringify(auditUrl)}); for (let i = 0; i < 10; i++) a.append(process.argv[1], { event: 'pre', w: process.argv[2], i });`;
  await Promise.all([1, 2, 3, 4].map(w => new Promise((resolve, reject) => {
    spawn(process.execPath, ['--input-type=module', '-e', script, file, String(w)], { stdio: 'inherit' })
      .on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  })));
  assert.deepEqual(verify(file), { ok: true, entries: 40, brokenAt: null, problem: null });
});
