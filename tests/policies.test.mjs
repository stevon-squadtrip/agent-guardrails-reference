// Must-block and must-allow cases for each policy. Near-misses that must be
// allowed are in false-positives.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bash, tool, cases, makeCtx, decide, INFRA, HOME, PROJECT } from './helpers.mjs';
import { memorySession } from '../.claude/hooks/lib/session.mjs';

// infra-actions. Preconditions are satisfied here so these rows test the
// action rules on their own.
const ready = () => makeCtx({
  session: memorySession([
    { key: 'health:prod:standby', ts: Date.parse('2026-01-01T11:55:00Z'), data: { result: 'healthy', build: '42' } },
    { key: 'snapshot:prod', ts: Date.parse('2026-01-01T11:55:00Z'), data: { id: 'prod-1' } },
  ]),
});

cases([
  ['infra: reads are allowed everywhere', bash(`${INFRA} status && ${INFRA} logs --env prod && ${INFRA} config get --env prod`), 'allow'],
  ['infra: health check on prod is allowed', bash(`${INFRA} health --env prod --slot standby`), 'allow'],
  ['infra: deploy to dev is allowed', bash(`${INFRA} deploy --env dev --build 43`), 'allow'],
  ['infra: deploy to prod defaults to standby and is allowed', bash(`${INFRA} deploy --env prod --build 42`), 'allow'],
  ['infra: deploy to prod live is denied', bash(`${INFRA} deploy --env prod --build 42 --slot live`), 'deny', 'infra-actions'],
  ['infra: --slot=live spelling is denied too', bash(`${INFRA} deploy --env=prod --build=42 --slot=live`), 'deny', 'infra-actions'],
  ['infra: swap prod asks', bash(`${INFRA} swap --env prod`), 'ask', 'infra-actions'],
  ['infra: config set prod asks', bash(`${INFRA} config set --env prod MAX_CONNECTIONS=200`), 'ask', 'infra-actions'],
  ['infra: config set staging is allowed', bash(`${INFRA} config set --env staging MAX_CONNECTIONS=200`), 'allow'],
  ['infra: config restore prod asks', bash(`${INFRA} config restore --env prod`), 'ask', 'infra-actions'],
  ['infra: snapshot is allowed', bash(`${INFRA} config snapshot --env prod`), 'allow'],
  ['infra: rotating a prod secret asks', bash(`${INFRA} secrets rotate --env prod API_SIGNING_KEY`), 'ask', 'infra-actions'],
  ['infra: rotating a dev secret is allowed', bash(`${INFRA} secrets rotate --env dev API_SIGNING_KEY`), 'allow'],
  ['infra: destroying prod is denied', bash(`${INFRA} env destroy --env prod`), 'deny', 'infra-actions'],
  ['infra: destroying staging asks', bash(`${INFRA} env destroy --env staging`), 'ask', 'infra-actions'],
  ['infra: bare infractl on PATH is recognised', bash('infractl env destroy --env prod'), 'deny', 'infra-actions'],
  ['infra: node options before the script are skipped', bash('node --no-warnings ./example-infra/infractl.mjs env destroy --env prod'), 'deny', 'infra-actions'],
  ['infra: second command in a chain is checked', bash(`${INFRA} status && ${INFRA} env destroy --env prod`), 'deny', 'infra-actions'],
  ['infra: inside $( ) is checked', bash(`echo $(${INFRA} env destroy --env prod)`), 'deny', 'infra-actions'],
  ['infra: inside bash -c is checked', bash(`bash -c "${INFRA} env destroy --env prod"`), 'deny', 'infra-actions'],
  ['infra: unknown prod command asks', bash(`${INFRA} config purge --env prod`), 'ask', 'infra-actions'],
  ['infra: arguments the CLI rejects are allowed (the CLI refuses them)', bash(`${INFRA} swap -e prod`), 'allow'],
], ready);

test('infra: an ask reason includes the checklist and the rollback', () => {
  const result = decide(bash(`${INFRA} swap --env prod`), ready());
  assert.match(result.reason, /Before approving:/);
  assert.match(result.reason, /Rollback is `infractl swap --env prod` again/);
});

// protected-branch
const onMain = (merging = false) => () => makeCtx({ git: { branch: () => 'main', merging: () => merging } });

cases([
  ['branch: commit on main is denied', bash('git commit -m "fix"'), 'deny', 'protected-branch'],
  ['branch: commit --amend on main is denied', bash('git commit --amend --no-edit'), 'deny', 'protected-branch'],
  ['branch: git -C dir commit on main is denied', bash('git -C sub/dir commit -m "fix"'), 'deny', 'protected-branch'],
  ['branch: global options before commit are skipped', bash('git -c user.name=x --no-pager commit -m "fix"'), 'deny', 'protected-branch'],
], onMain());

cases([
  ['branch: the commit that concludes a merge is allowed', bash('git commit --no-edit'), 'allow'],
], onMain(true));

cases([
  ['branch: switching to a new branch first is allowed', bash('git switch -c fix/timeout && git commit -m "fix"'), 'allow'],
  ['branch: checkout -b first is allowed', bash('git checkout -b fix/timeout && git commit -m "fix"'), 'allow'],
], onMain());

cases([
  ['branch: commit on a feature branch is allowed', bash('git commit -m "fix"'), 'allow'],
]);

test('branch: the protected list is configurable', () => {
  const ctx = makeCtx({ protectedBranches: ['main', 'release'], git: { branch: () => 'release', merging: () => false } });
  assert.equal(decide(bash('git commit -m "fix"'), ctx).decision, 'deny');
});

test('branch: -C is resolved against the project directory', () => {
  let probed;
  const ctx = makeCtx({ git: { branch: dir => { probed = dir; return 'main'; }, merging: () => false } });
  decide(bash('git -C sub commit -m "x"'), ctx);
  assert.equal(probed, `${PROJECT}${PROJECT.includes('\\') ? '\\' : '/'}sub`);
});

// destructive-shell
cases([
  ['shell: rm -rf / is denied', bash('rm -rf /'), 'deny', 'destructive-shell'],
  ['shell: rm -rf ~ is denied', bash('rm -rf ~'), 'deny', 'destructive-shell'],
  ['shell: rm -r -f with a parent path is denied', bash('rm -r -f ../other-project'), 'deny', 'destructive-shell'],
  ['shell: rm --recursive outside is denied', bash('rm --recursive --force /var/lib'), 'deny', 'destructive-shell'],
  ['shell: rm -fr . (the repo itself) is denied', bash('rm -fr .'), 'deny', 'destructive-shell'],
  ['shell: rm -rf .git is denied', bash('rm -rf .git'), 'deny', 'destructive-shell'],
  ['shell: rm -rf through sudo is denied', bash('sudo rm -rf /etc'), 'deny', 'destructive-shell'],
  ['shell: rm -rf with a variable asks', bash('rm -rf "$BUILD_DIR"'), 'ask', 'destructive-shell'],
  ['shell: rm -rf inside the repo is allowed', bash('rm -rf build/ dist node_modules/.cache'), 'allow'],
  ['shell: plain rm outside the repo is not this policy', bash('rm /tmp/scratch.txt'), 'allow'],
  ['shell: git push --force is denied', bash('git push --force origin feature/work'), 'deny', 'destructive-shell'],
  ['shell: git push -f is denied', bash('git push -f'), 'deny', 'destructive-shell'],
  ['shell: combined short flags with f are denied', bash('git push -uf origin feature/work'), 'deny', 'destructive-shell'],
  ['shell: +refspec force push is denied', bash('git push origin +feature/work'), 'deny', 'destructive-shell'],
  ['shell: --force-with-lease asks', bash('git push --force-with-lease origin feature/work'), 'ask', 'destructive-shell'],
  ['shell: push to main asks', bash('git push origin main'), 'ask', 'destructive-shell'],
  ['shell: push HEAD:main asks', bash('git push origin HEAD:refs/heads/main'), 'ask', 'destructive-shell'],
  ['shell: deleting main on the remote is denied', bash('git push origin --delete main'), 'deny', 'destructive-shell'],
  ['shell: push a feature branch is allowed', bash('git push -u origin feature/work'), 'allow'],
]);

cases([
  ['shell: bare git push while on main asks', bash('git push'), 'ask', 'destructive-shell'],
  ['shell: git push origin HEAD while on main asks', bash('git push origin HEAD'), 'ask', 'destructive-shell'],
], onMain());

// protected-paths
cases([
  ['paths: Edit on settings.json asks', tool('Edit', { file_path: `${PROJECT}/.claude/settings.json` }), 'ask', 'protected-paths'],
  ['paths: Write on a hook asks', tool('Write', { file_path: '.claude/hooks/guard.mjs', content: '' }), 'ask', 'protected-paths'],
  ['paths: MultiEdit on a policy asks', tool('MultiEdit', { file_path: '.claude/hooks/policies/infra-actions.mjs', edits: [] }), 'ask', 'protected-paths'],
  ['paths: sed -i on settings.json asks', bash(`sed -i 's/a/b/' .claude/settings.json`), 'ask', 'protected-paths'],
  ['paths: sed -i -e on a hook asks', bash(`sed -i.bak -e 's/a/b/' .claude/hooks/guard.mjs`), 'ask', 'protected-paths'],
  ['paths: redirect into a hook asks', bash('echo "" > .claude/hooks/guard.mjs'), 'ask', 'protected-paths'],
  ['paths: tee into settings asks', bash('cat x | tee .claude/settings.json'), 'ask', 'protected-paths'],
  ['paths: cp over a policy asks', bash('cp /tmp/noop.mjs .claude/hooks/policies/infra-actions.mjs'), 'ask', 'protected-paths'],
  ['paths: mv into the hooks dir asks', bash('mv noop.mjs .claude/hooks/'), 'ask', 'protected-paths'],
  ['paths: deleting the audit log asks', bash('rm .claude/audit/audit.jsonl'), 'ask', 'protected-paths'],
  ['paths: writing precondition records is denied', bash('echo "{}" > .claude/state/session-1.json'), 'deny', 'protected-paths'],
  ['paths: Write to prod state asks', tool('Write', { file_path: 'example-infra/state/prod.json', content: '{}' }), 'ask', 'protected-paths'],
  ['paths: Write to dev state is allowed', tool('Write', { file_path: 'example-infra/state/dev.json', content: '{}' }), 'allow'],
  ['paths: user-level settings asks', tool('Edit', { file_path: `${HOME}/.claude/settings.json` }), 'ask', 'protected-paths'],
  ['paths: ~ in a shell path is expanded', bash('echo "{}" > ~/.claude/settings.json'), 'ask', 'protected-paths'],
]);

// secrets-files
cases([
  ['secrets: Write .env is denied', tool('Write', { file_path: '.env', content: 'X=1' }), 'deny', 'secrets-files'],
  ['secrets: Write .env.production is denied', tool('Write', { file_path: 'config/.env.production', content: '' }), 'deny', 'secrets-files'],
  ['secrets: Write a .pem is denied', tool('Write', { file_path: 'certs/server.pem', content: '' }), 'deny', 'secrets-files'],
  ['secrets: redirect into .env is denied', bash('echo "API_SIGNING_KEY=abc" >> .env'), 'deny', 'secrets-files'],
  ['secrets: cp a key into a directory is denied', bash('cp ~/keys/deploy.key ./config/'), 'deny', 'secrets-files'],
  ['secrets: touch id_ed25519 is denied', bash('touch id_ed25519'), 'deny', 'secrets-files'],
  ['secrets: .env.example is allowed', tool('Write', { file_path: '.env.example', content: 'X=' }), 'allow'],
  ['secrets: reading .env is not a write', bash('cat .env'), 'allow'],
  ['secrets: deleting .env is not a write', bash('rm .env'), 'allow'],
]);
