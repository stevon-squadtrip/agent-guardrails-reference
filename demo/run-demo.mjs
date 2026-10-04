#!/usr/bin/env node
// Sends each fixture through the real hook (a fresh `node guard.mjs` process
// per event, JSON on stdin, exactly as Claude Code runs it) and prints what
// it decided.
//
// Each fixture states the decision it expects. Any mismatch exits 1, so the
// table in the README can't silently drift from what the code does.

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, '.claude', 'hooks', 'guard.mjs');
const FIXTURES = path.join(ROOT, 'demo', 'fixtures');

// A throwaway git repo stands in for the project, so branch-dependent cases
// don't depend on whatever branch this checkout is on.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-demo-'));
execFileSync('git', ['init', '-q', sandbox]);

const env = { ...process.env };
for (const key of Object.keys(env)) if (key === 'CLAUDE_PROJECT_DIR' || key.startsWith('GUARD_')) delete env[key];

const rows = [];
let mismatches = 0;

for (const file of fs.readdirSync(FIXTURES).filter(f => f.endsWith('.json')).sort()) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  prepareGit(fixture);
  const session = `demo-${file.replace(/\.json$/, '')}`;

  for (const step of fixture.setup ?? []) send({ hook_event_name: 'PostToolUse', session_id: session, ...step });
  const output = send({ hook_event_name: 'PreToolUse', session_id: session, ...fixture.event });

  const decision = output?.hookSpecificOutput?.permissionDecision ?? 'allow';
  const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? '';
  const ok = decision === fixture.expect;
  if (!ok) mismatches++;
  rows.push({
    name: fixture.name,
    tool: fixture.event.tool_name,
    decision: ok ? decision : `${decision} (expected ${fixture.expect})`,
    policy: policyFor(reason, decision),
    reason: firstSentence(reason),
  });
}

printTable(rows);
console.log(`\n${rows.length - mismatches}/${rows.length} cases matched their expected decision.`);
fs.rmSync(sandbox, { recursive: true, force: true });
if (mismatches) process.exitCode = 1;

function send(event) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: sandbox, ...event }),
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) throw new Error(`guard exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function prepareGit(fixture) {
  execFileSync('git', ['-C', sandbox, 'symbolic-ref', 'HEAD', `refs/heads/${fixture.branch ?? 'main'}`]);
  const mergeHead = path.join(sandbox, '.git', 'MERGE_HEAD');
  if (fixture.merging) fs.writeFileSync(mergeHead, `${'0'.repeat(40)}\n`);
  else fs.rmSync(mergeHead, { force: true });
}

// The hook's output carries only the reason, as Claude Code expects. The
// policy name comes from the audit log entry the same call just wrote.
function policyFor(reason, decision) {
  if (decision === 'allow') return '-';
  const log = path.join(sandbox, '.claude', 'audit', 'audit.jsonl');
  const last = fs.readFileSync(log, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l)).findLast(e => e.event === 'pre');
  return last.reason === reason ? last.policies.join(', ') : '?';
}

function firstSentence(text) {
  if (!text) return '-';
  const line = text.split('\n')[0];
  const sentence = line.match(/^.*?[.?!](?=\s|$)/)?.[0] ?? line;
  return sentence.length > 90 ? `${sentence.slice(0, 87)}...` : sentence;
}

function printTable(rows) {
  const cols = [
    ['CASE', 'name'], ['TOOL', 'tool'], ['DECISION', 'decision'], ['POLICY', 'policy'], ['REASON', 'reason'],
  ];
  const widths = cols.map(([title, key]) => Math.max(title.length, ...rows.map(r => r[key].length)));
  const line = cells => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  console.log(line(cols.map(([title]) => title)));
  for (const r of rows) console.log(line(cols.map(([, key]) => r[key])));
}
