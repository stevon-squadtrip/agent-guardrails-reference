// Append-only, hash-chained JSONL audit log.
//
// Each entry stores the hash of the entry before it, and its own hash covers
// its content plus that link. Editing, inserting or removing a line in the
// middle breaks the chain from that point on. Cutting lines off the end, or
// replacing the whole file, does not: catching that needs the latest hash
// kept somewhere the agent cannot write to.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const GENESIS = '0'.repeat(64);
const TAIL_BYTES = 64 * 1024;

export function hashEntry(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function append(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(`${file}.lock`, () => {
    const body = { ts: new Date().toISOString(), ...entry, prev: lastHash(file) };
    const line = JSON.stringify({ ...body, hash: hashEntry(body) });
    fs.appendFileSync(file, line + '\n');
    return line;
  });
}

export function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// { ok, entries, brokenAt (1-based line), problem }
export function verify(file) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { ok: false, entries: lines.length, brokenAt: i + 1, problem: 'not valid JSON' };
    }
    const { hash, ...body } = entry;
    if (body.prev !== prev) {
      return { ok: false, entries: lines.length, brokenAt: i + 1, problem: 'does not link to the previous line (a line was removed, inserted or reordered)' };
    }
    if (hashEntry(body) !== hash) {
      return { ok: false, entries: lines.length, brokenAt: i + 1, problem: 'content does not match its hash (the line was edited)' };
    }
    prev = hash;
  }
  return { ok: true, entries: lines.length, brokenAt: null, problem: null };
}

function lastHash(file) {
  if (!fs.existsSync(file)) return GENESIS;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const last = buf.toString('utf8').trimEnd().split('\n').pop();
    return last ? JSON.parse(last).hash : GENESIS;
  } finally {
    fs.closeSync(fd);
  }
}

// Claude Code can run hooks for parallel tool calls at the same time. Without
// a lock, two appends could read the same previous hash and fork the chain.
function withLock(lockDir, fn) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (isStale(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error(`audit log locked: ${lockDir}`);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function isStale(lockDir) {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > 5000;
  } catch {
    return false;
  }
}
