// No commits on a protected branch. Changes reach main through a merge.
//
// One exception: the commit that concludes a merge (MERGE_HEAD exists). The
// change being merged was already reviewed on its own branch.

import { parseGit } from '../lib/commands.mjs';
import { resolvePath } from '../lib/paths.mjs';
import { deny } from '../lib/decision.mjs';

export default {
  name: 'protected-branch',
  check(call, ctx) {
    let switchedBranch = false;
    for (const { argv } of call.commands) {
      const git = parseGit(argv);
      if (!git) continue;

      // `git switch -c fix && git commit ...` commits on the new branch, but
      // the guard runs before either, while HEAD is still main.
      if ((git.sub === 'switch' || git.sub === 'checkout') && git.args.some(a => /^-[cCbB]$/.test(a))) {
        switchedBranch = true;
      }
      if (git.sub !== 'commit' || switchedBranch) continue;

      const dir = git.dir ? resolvePath(git.dir, ctx.projectDir, ctx.home) : ctx.projectDir;
      const branch = ctx.git.branch(dir);
      if (!branch || !ctx.protectedBranches.includes(branch)) continue;
      if (ctx.git.merging(dir)) continue;

      return deny(`You are on ${branch}, which only takes merges. Create a branch first (\`git switch -c <name>\`) and commit there.`);
    }
    return null;
  },
};
