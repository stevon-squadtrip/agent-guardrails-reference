// Files that need a human before they change: the guardrails themselves,
// their records, and live state.
//
// Matched against every way a tool call can change a file (Write, Edit,
// MultiEdit, NotebookEdit, shell redirects, sed -i, cp, mv, tee, rm). See
// fileTargets() in lib/commands.mjs.

import { fileTargets } from '../lib/commands.mjs';
import { resolvePath, relativeTo, globToRegExp } from '../lib/paths.mjs';
import { stricter } from '../lib/decision.mjs';

const PROJECT = [
  { glob: '.claude/settings.json', decision: 'ask', why: 'it turns these hooks on and off' },
  { glob: '.claude/settings.local.json', decision: 'ask', why: 'it can override which hooks run' },
  { glob: '.claude/hooks/**', decision: 'ask', why: 'it is part of the guard' },
  { glob: '.claude/audit/**', decision: 'ask', why: 'it is the audit log' },
  { glob: '.claude/state/**', decision: 'deny', why: 'writing it would fake a completed check' },
  { glob: 'example-infra/state/prod.json', decision: 'ask', why: 'it is live prod state, which changes through infractl so the guard sees it' },
  { glob: 'example-infra/state/snapshots/**', decision: 'ask', why: 'snapshots are the rollback path' },
].map(p => ({ ...p, re: globToRegExp(p.glob) }));

// User-level settings can register or remove hooks for every project.
const HOME = [
  { glob: '.claude/settings.json', decision: 'ask', why: 'user-level settings can turn hooks off for every project' },
].map(p => ({ ...p, re: globToRegExp(p.glob) }));

export default {
  name: 'protected-paths',
  check(call, ctx) {
    let result = null;
    for (const target of fileTargets(call)) {
      const abs = resolvePath(target.path, ctx.projectDir, ctx.home);
      const inProject = relativeTo(ctx.projectDir, abs);
      const inHome = relativeTo(ctx.home, abs);
      const hit = (inProject !== null && PROJECT.find(p => p.re.test(inProject))) ||
        (inHome !== null && HOME.find(p => p.re.test(inHome)));
      if (!hit) continue;
      const verb = target.kind === 'delete' ? 'Deleting' : 'Changing';
      result = stricter(result, {
        decision: hit.decision,
        reason: `${inProject ?? `~/${inHome}`} is protected: ${hit.why}. (${verb} via ${target.via}.)`,
      });
    }
    return result;
  },
};
