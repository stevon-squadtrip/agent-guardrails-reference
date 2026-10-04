#!/usr/bin/env node
// SessionStart hook: tells the agent where it is before it does anything.
// Best effort. Any part that fails is left out rather than failing the session.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readEntries, verify } from './lib/audit.mjs';
import { projectDirFor, auditFileFor, readStdin } from './lib/engine.mjs';

let input = {};
try {
  input = JSON.parse((await readStdin()) || '{}');
} catch {
  // Brief without session details.
}

const projectDir = projectDirFor(input);
const lines = ['Guardrails are active in this repo (see README.md).'];

attempt(() => {
  const branch = git('symbolic-ref', '--short', '-q', 'HEAD');
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean).length;
  lines.push(`Git: on ${branch}${dirty ? `, ${dirty} uncommitted change(s)` : ', clean'}.`);
  if (branch === 'main') lines.push('Commits on main are blocked. Create a branch before committing.');
});

attempt(() => {
  const stateDir = path.join(projectDir, 'example-infra', 'state');
  if (!fs.existsSync(stateDir)) {
    lines.push('Environments: not created yet. The first infractl command, or `npm run reset`, creates them.');
    return;
  }
  const envs = ['dev', 'staging', 'prod'].map(name => {
    const file = path.join(stateDir, `${name}.json`);
    if (!fs.existsSync(file)) return `${name}: destroyed`;
    const slots = JSON.parse(fs.readFileSync(file, 'utf8')).slots;
    return `${name}: ${Object.entries(slots).map(([s, v]) => `${s}=build ${v.build}`).join(', ')}`;
  });
  lines.push(`Environments: ${envs.join('; ')}.`);
});

attempt(() => {
  const file = auditFileFor(input);
  const errors = readEntries(file).filter(e => e.event === 'guard_error').length;
  if (errors) lines.push(`The audit log has ${errors} guard_error entries, so some checks may not be running. Run \`npm run audit:report\`.`);
  const chain = verify(file);
  if (!chain.ok) lines.push(`The audit log chain is broken at line ${chain.brokenAt}: ${chain.problem}.`);
});

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
}));

function git(...args) {
  return execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function attempt(fn) {
  try {
    fn();
  } catch {
    // Leave this part out.
  }
}
