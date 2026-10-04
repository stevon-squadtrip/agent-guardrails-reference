// Shell commands that destroy things outside the agent's working area, or
// rewrite history other people depend on.

import { commandName } from '../lib/shell.mjs';
import { parseGit } from '../lib/commands.mjs';
import { resolvePath, relativeTo } from '../lib/paths.mjs';
import { stricter, deny, ask } from '../lib/decision.mjs';

export default {
  name: 'destructive-shell',
  check(call, ctx) {
    let result = null;
    for (const { argv } of call.commands) {
      if (commandName(argv[0]) === 'rm') result = stricter(result, checkRm(argv.slice(1), ctx));
      const git = parseGit(argv);
      if (git?.sub === 'push') result = stricter(result, checkPush(git, ctx));
    }
    return result;
  },
};

// Recursive deletes stay inside the repo, and never take the repo or its
// history with them.
function checkRm(args, ctx) {
  let recursive = false;
  let optionsDone = false;
  const targets = [];
  for (const a of args) {
    if (!optionsDone && a === '--') optionsDone = true;
    else if (!optionsDone && a.startsWith('--')) recursive ||= a === '--recursive';
    else if (!optionsDone && a.startsWith('-') && a.length > 1) recursive ||= /[rR]/.test(a);
    else targets.push(a);
  }
  if (!recursive) return null;

  let result = null;
  for (const t of targets) {
    if (/[$`]/.test(t)) {
      result = stricter(result, ask(`Recursive delete of ${t} depends on a variable the guard can't expand. It can't tell whether the target is inside the repo.`));
      continue;
    }
    const abs = resolvePath(t, ctx.projectDir, ctx.home);
    const rel = relativeTo(ctx.projectDir, abs);
    if (rel === null) return deny(`Recursive delete of ${t} reaches outside the repo. Agent sessions only delete recursively inside the project.`);
    if (rel === '') return deny(`Recursive delete of ${t} would delete the whole repo.`);
    if (rel === '.git' || rel.startsWith('.git/')) return deny(`Recursive delete of ${t} would delete git history.`);
  }
  return result;
}

function checkPush(git, ctx) {
  const options = git.args.filter(a => a.startsWith('-'));
  const [, ...refspecs] = git.args.filter(a => !a.startsWith('-'));

  const forced = options.some(o => o === '--force' || o === '--mirror' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(o)) ||
    refspecs.some(r => r.startsWith('+'));
  if (forced) {
    return deny('Force-pushing rewrites history other people may have pulled. Push a new commit instead, or ask a human to do it.');
  }

  const leased = options.some(o => o.startsWith('--force-with-lease') || o === '--force-if-includes');
  if (leased) {
    return ask('--force-with-lease is safer than --force, but it still rewrites the remote branch. Confirm nobody else has pushed to it.');
  }

  const current = () => ctx.git.branch(git.dir ? resolvePath(git.dir, ctx.projectDir, ctx.home) : ctx.projectDir);
  const destinations = refspecs.map(r => r.split(':').pop().replace(/^refs\/heads\//, ''))
    .map(d => (d === 'HEAD' ? current() : d));
  const deleting = options.includes('--delete') || options.includes('-d') || refspecs.some(r => r.startsWith(':'));
  const touched = refspecs.length ? destinations : options.includes('--all') ? ctx.protectedBranches : [current()];
  const protectedHit = touched.find(b => ctx.protectedBranches.includes(b));

  if (protectedHit && deleting) return deny(`This deletes ${protectedHit} on the remote.`);
  if (protectedHit) {
    return ask(`This pushes directly to ${protectedHit}.\nBefore approving:\n- Tests pass locally.\n- This change would normally go through review. Is skipping that intended?`);
  }
  return null;
}
