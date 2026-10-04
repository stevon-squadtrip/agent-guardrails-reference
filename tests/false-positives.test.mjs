// Near-misses: commands that mention something dangerous without doing it.
// A guard that blocks these trains people to approve on reflex, and then the
// approval prompt stops meaning anything.

import { bash, tool, cases, makeCtx, INFRA } from './helpers.mjs';

const onMain = () => makeCtx({ git: { branch: () => 'main', merging: () => false } });

cases([
  ['commit message that mentions destroying prod', bash('git commit -m "docs: never run infractl env destroy --env prod"'), 'allow'],
  ['heredoc commit message that mentions a swap', bash(`git commit -F - <<'EOF'\nDon't run infractl swap --env prod by hand\nEOF`), 'allow'],
  ['runbook written with a heredoc', bash(`cat > runbook.md <<'EOF'\n1. infractl deploy --env prod --slot live\n2. rm -rf /\nEOF`), 'allow'],
  ['grep for the dangerous command', bash('grep -rn "infractl env destroy" docs/'), 'allow'],
  ['echo with single quotes', bash(`echo 'infractl swap --env prod'`), 'allow'],
  ['commented-out command', bash(`# ${INFRA} env destroy --env prod\n${INFRA} status`), 'allow'],
  ['editing a file that mentions the CLI', bash(`sed -i 's/--slot live/--slot standby/' docs/runbook.md`), 'allow'],
  ['reading the guard', bash('cat .claude/hooks/policies/infra-actions.mjs'), 'allow'],
  ['tests that reference .env in a string', tool('Write', { file_path: 'tests/env.test.mjs', content: 'readFile(".env")' }), 'allow'],
  ['a file named like a key but not one', tool('Write', { file_path: 'docs/keyboard-shortcuts.md', content: '' }), 'allow'],
  ['redirect to /dev/null', bash(`${INFRA} status > /dev/null 2>&1`), 'allow'],
  ['rm -rf of a path whose name contains "..": inside the repo', bash('rm -rf build/..cache'), 'allow'],
  ['git log on main', bash('git log --oneline -5'), 'allow'],
  ['status of prod', bash(`${INFRA} status --env prod`), 'allow'],
  ['staging deploy that mentions prod in the build note', bash(`${INFRA} deploy --env staging --build 42 # before prod`), 'allow'],
]);

cases([
  ['git pull on main', bash('git pull --ff-only'), 'allow'],
  ['git merge into main (the merge commit is made by merge itself)', bash('git merge --no-ff feature/work'), 'allow'],
  ['push of a feature branch while on main, by name', bash('git push origin feature/work'), 'allow'],
], onMain);
