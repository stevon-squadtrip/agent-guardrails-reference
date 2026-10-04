// Runs policies over a tool call and combines their results. Kept separate
// from guard.mjs so tests and the demo can call it directly.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCommand, ShellParseError } from './shell.mjs';
import { RANK, BY_RANK } from './decision.mjs';
import { openSession } from './session.mjs';
import { redact } from './redact.mjs';

import infraActions from '../policies/infra-actions.mjs';
import preconditions from '../policies/preconditions.mjs';
import protectedBranch from '../policies/protected-branch.mjs';
import destructiveShell from '../policies/destructive-shell.mjs';
import protectedPaths from '../policies/protected-paths.mjs';
import secretsFiles from '../policies/secrets-files.mjs';

export const POLICIES = [infraActions, preconditions, protectedBranch, destructiveShell, protectedPaths, secretsFiles];

export function toCall(input) {
  const call = { tool: input.tool_name, input: input.tool_input ?? {}, commands: [], parseError: null };
  if (call.tool === 'Bash' && typeof call.input.command === 'string') {
    try {
      call.commands = parseCommand(call.input.command);
    } catch (err) {
      if (!(err instanceof ShellParseError)) throw err;
      call.parseError = err.message;
    }
  }
  return call;
}

// Every policy runs, and the strictest result wins: deny > ask > allow.
// One policy throwing doesn't stop the others. What happens to the call it
// was checking depends on ctx.failMode.
export function evaluate(call, ctx, policies = POLICIES) {
  const hits = [];
  const errors = [];

  if (call.parseError) {
    hits.push({
      policy: 'shell-parse',
      decision: 'ask',
      reason: `The guard could not parse this command (${call.parseError}). None of its checks ran, so read it before approving.`,
    });
  }

  for (const policy of policies) {
    try {
      const result = policy.check(call, ctx);
      if (result) hits.push({ policy: policy.name, ...result });
    } catch (err) {
      errors.push({ policy: policy.name, error: String(err?.stack ?? err) });
      if (ctx.failMode === 'closed') {
        hits.push({
          policy: policy.name,
          decision: 'deny',
          reason: `Policy ${policy.name} failed, and GUARD_FAIL_MODE=closed, so calls it checks are denied until it is fixed.`,
        });
      }
    }
  }

  const top = Math.max(0, ...hits.map(h => RANK[h.decision]));
  const winners = hits.filter(h => RANK[h.decision] === top);
  return {
    decision: BY_RANK[top],
    policies: winners.map(h => h.policy),
    reason: winners.map(h => h.reason).join('\n\n'),
    errors,
  };
}

// PostToolUse: let policies record what completed.
export function observe(call, response, ctx, policies = POLICIES) {
  const recorded = [];
  const errors = [];
  for (const policy of policies) {
    if (!policy.observe) continue;
    try {
      recorded.push(...(policy.observe(call, response, ctx) ?? []));
    } catch (err) {
      errors.push({ policy: policy.name, error: String(err?.stack ?? err) });
    }
  }
  return { recorded, errors };
}

export function projectDirFor(input, env = process.env) {
  return env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
}

export function auditFileFor(input, env = process.env) {
  return env.GUARD_AUDIT_FILE || path.join(projectDirFor(input, env), '.claude', 'audit', 'audit.jsonl');
}

export function createContext(input, env = process.env) {
  const projectDir = projectDirFor(input, env);
  return {
    projectDir,
    home: os.homedir(),
    now: () => Date.now(),
    failMode: env.GUARD_FAIL_MODE === 'closed' ? 'closed' : 'open',
    ttlMs: Number(env.GUARD_PRECONDITION_TTL_MIN || 30) * 60_000,
    protectedBranches: (env.GUARD_PROTECTED_BRANCHES || 'main').split(',').map(s => s.trim()).filter(Boolean),
    session: openSession(env.GUARD_STATE_DIR || path.join(projectDir, '.claude', 'state'), input.session_id),
    git: gitProbe(),
    auditFile: auditFileFor(input, env),
  };
}

// Called only by policies that need it, so most tool calls never spawn git.
function gitProbe() {
  const git = (dir, args) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  return {
    branch: dir => git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
    merging: dir => {
      const p = git(dir, ['rev-parse', '--git-path', 'MERGE_HEAD']);
      return p ? fs.existsSync(path.resolve(dir, p)) : false;
    },
  };
}

// What goes in the audit log for a tool call: the command or the file path,
// never file contents.
export function summarizeInput(call) {
  const { tool, input } = call;
  switch (tool) {
    case 'Bash': return redact({ command: input.command });
    case 'Write': return { file_path: input.file_path, bytes: input.content?.length ?? 0 };
    case 'Edit': return { file_path: input.file_path };
    case 'MultiEdit': return { file_path: input.file_path, edits: input.edits?.length ?? 0 };
    case 'NotebookEdit': return { notebook_path: input.notebook_path };
    default: return { keys: Object.keys(input) };
  }
}

const MAX_RESPONSE = 2000;

export function summarizeResponse(response) {
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? null);
  const clipped = text.length > MAX_RESPONSE ? `${text.slice(0, MAX_RESPONSE)}... [${text.length - MAX_RESPONSE} more chars]` : text;
  return redact(clipped);
}

export async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
