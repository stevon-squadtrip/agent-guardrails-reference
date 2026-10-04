import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { toCall, evaluate } from '../.claude/hooks/lib/engine.mjs';
import { memorySession } from '../.claude/hooks/lib/session.mjs';

export const PROJECT = path.resolve('/work/repo');
export const HOME = path.resolve('/home/dev');
export const NOW = Date.parse('2026-01-01T12:00:00Z');
export const MINUTE = 60_000;
export const INFRA = 'node example-infra/infractl.mjs';

export function makeCtx(overrides = {}) {
  return {
    projectDir: PROJECT,
    home: HOME,
    now: () => NOW,
    failMode: 'open',
    ttlMs: 30 * MINUTE,
    protectedBranches: ['main'],
    session: memorySession(),
    git: { branch: () => 'feature/work', merging: () => false },
    ...overrides,
  };
}

export const bash = command => toCall({ tool_name: 'Bash', tool_input: { command } });
export const tool = (tool_name, tool_input) => toCall({ tool_name, tool_input });

export function decide(call, ctx = makeCtx()) {
  return evaluate(call, ctx);
}

// One test per row of [description, call, expected decision, expected policy?].
export function cases(rows, ctx = makeCtx) {
  for (const [name, call, decision, policy] of rows) {
    test(name, () => {
      const result = decide(call, ctx());
      assert.equal(result.decision, decision, result.reason || '(no reason)');
      if (policy) assert.ok(result.policies.includes(policy), `expected ${policy}, got ${result.policies.join(', ') || 'none'}`);
    });
  }
}
