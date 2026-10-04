#!/usr/bin/env node
// Summarises the audit log: what was denied and asked, which asks a human
// approved, guard errors, and policies that never fired.
//
// A policy that never fires might be fine, or it might be broken. With
// fail-open, a broken policy looks exactly like a quiet one, so this report
// is where you would notice.

import { readEntries, verify } from '../.claude/hooks/lib/audit.mjs';
import { POLICIES, auditFileFor } from '../.claude/hooks/lib/engine.mjs';

const file = process.argv[2] ?? auditFileFor({ cwd: process.cwd() });
const entries = readEntries(file);

if (!entries.length) {
  console.log(`No audit entries yet (${file}).`);
  process.exit(0);
}

const pre = entries.filter(e => e.event === 'pre');
const post = entries.filter(e => e.event === 'post');
const errors = entries.filter(e => e.event === 'guard_error');

console.log(`Audit log: ${file}`);
console.log(`Period:    ${entries[0].ts} to ${entries.at(-1).ts}`);
console.log(`Chain:     ${describeChain(verify(file))}\n`);

const byDecision = count(pre.map(e => e.decision));
console.log(`Tool calls checked: ${pre.length}`);
for (const d of ['allow', 'ask', 'deny']) console.log(`  ${d.padEnd(6)} ${byDecision[d] ?? 0}`);

const fired = count(pre.flatMap(e => (e.policies ?? []).map(p => `${p} (${e.decision})`)));
console.log('\nBy policy:');
for (const [k, n] of Object.entries(fired).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

// An ask was approved if the same tool call later produced a result.
const asks = pre.filter(e => e.decision === 'ask');
const approved = asks.filter(a => post.some(p => sameCall(a, p) && p.ts >= a.ts));
console.log(`\nAsks: ${asks.length}, approved ${approved.length}, declined or abandoned ${asks.length - approved.length}`);

console.log(`\nGuard errors: ${errors.length}`);
for (const e of errors.slice(-5)) console.log(`  ${e.ts}  ${e.policy}: ${e.error.split('\n')[0]}`);

const silent = POLICIES.map(p => p.name).filter(name => !pre.some(e => e.policies?.includes(name)));
console.log(`\nPolicies that never fired: ${silent.length ? silent.join(', ') : 'none'}`);
if (silent.length) console.log('  Quiet can mean nothing risky happened, or that the policy is broken. Check which.');

function sameCall(a, b) {
  if (a.tool_use_id && b.tool_use_id) return a.tool_use_id === b.tool_use_id;
  return a.session === b.session && a.tool === b.tool && JSON.stringify(a.input) === JSON.stringify(b.input);
}

function count(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function describeChain(r) {
  return r.ok ? `intact (${r.entries} entries)` : `BROKEN at line ${r.brokenAt}: ${r.problem}`;
}
