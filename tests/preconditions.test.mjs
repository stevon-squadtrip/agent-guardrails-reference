import assert from 'node:assert/strict';
import { test } from 'node:test';

import preconditions from '../.claude/hooks/policies/preconditions.mjs';
import { bash, decide, makeCtx, INFRA, NOW, MINUTE } from './helpers.mjs';

const swap = bash(`${INFRA} swap --env prod`);
const configSet = bash(`${INFRA} config set --env prod MAX_CONNECTIONS=200`);

function ran(ctx, command, stdout, minutesAgo = 0) {
  const now = ctx.now;
  ctx.now = () => NOW - minutesAgo * MINUTE;
  const recorded = preconditions.observe(bash(command), { stdout, stderr: '' }, ctx);
  ctx.now = now;
  return recorded;
}

const healthy = '[infractl] action=health env=prod slot=standby build=42 result=healthy';
const unhealthy = '[infractl] action=health env=prod slot=standby build=43 result=unhealthy';
const snapshot = '[infractl] action=config.snapshot env=prod id=prod-1';

test('swap is denied with no health check', () => {
  const r = decide(swap);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /Run `infractl health --env prod --slot standby` first/);
});

test('swap asks after a healthy check (the ask comes from infra-actions)', () => {
  const ctx = makeCtx();
  assert.deepEqual(ran(ctx, `${INFRA} health --env prod --slot standby`, healthy), ['health:prod:standby']);
  const r = decide(swap, ctx);
  assert.equal(r.decision, 'ask');
  assert.deepEqual(r.policies, ['infra-actions']);
});

test('swap is denied when standby failed its check', () => {
  const ctx = makeCtx();
  ran(ctx, `${INFRA} health --env prod --slot standby`, unhealthy);
  assert.match(decide(swap, ctx).reason, /failed its last health check/);
});

test('swap is denied when standby was redeployed after the check', () => {
  const ctx = makeCtx();
  ran(ctx, `${INFRA} health --env prod --slot standby`, healthy, 5);
  ran(ctx, `${INFRA} deploy --env prod --build 43`, '[infractl] action=deploy env=prod slot=standby build=43', 2);
  assert.match(decide(swap, ctx).reason, /went to standby after the last health check/);
});

test('a health check older than the TTL no longer counts', () => {
  const ctx = makeCtx();
  ran(ctx, `${INFRA} health --env prod --slot standby`, healthy, 31);
  const r = decide(swap, ctx);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /31 minutes ago/);
});

test('a health check of the live slot does not satisfy the standby requirement', () => {
  const ctx = makeCtx();
  ran(ctx, `${INFRA} health --env prod --slot live`, '[infractl] action=health env=prod slot=live build=41 result=healthy');
  assert.equal(decide(swap, ctx).decision, 'deny');
});

test('config set on prod is denied with no snapshot, asks after one', () => {
  const ctx = makeCtx();
  assert.equal(decide(configSet, ctx).decision, 'deny');
  ran(ctx, `${INFRA} config snapshot --env prod`, snapshot);
  assert.equal(decide(configSet, ctx).decision, 'ask');
});

test('a staging snapshot does not satisfy prod', () => {
  const ctx = makeCtx();
  ran(ctx, `${INFRA} config snapshot --env staging`, '[infractl] action=config.snapshot env=staging id=staging-1');
  assert.equal(decide(configSet, ctx).decision, 'deny');
});

test('echoing the result line records nothing', () => {
  const ctx = makeCtx();
  assert.deepEqual(ran(ctx, `echo "${snapshot}"`, snapshot), []);
  assert.equal(decide(configSet, ctx).decision, 'deny');
});

test('a result line for a different action than the one that ran records nothing', () => {
  const ctx = makeCtx();
  assert.deepEqual(ran(ctx, `${INFRA} status; echo "${snapshot}"`, `ok\n${snapshot}`), []);
});

test('a failed command with no result line records nothing', () => {
  const ctx = makeCtx();
  assert.deepEqual(ran(ctx, `${INFRA} config snapshot --env prod`, 'infractl: prod is destroyed'), []);
});

// Documents a limit stated in the README: the record comes from the
// command's own output, so a command that also prints the line can fake it.
test('LIMIT: infractl plus an echoed result line in one command is recorded', () => {
  const ctx = makeCtx();
  const cmd = `${INFRA} config snapshot --env prod || echo "${snapshot}"`;
  assert.deepEqual(ran(ctx, cmd, snapshot), ['snapshot:prod']);
});

test('records persist across hook processes through the session file', async () => {
  const { openSession } = await import('../.claude/hooks/lib/session.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-session-'));
  const first = openSession(dir, 'abc');
  first.add('snapshot:prod', { id: 'prod-1' }, NOW);
  first.save();
  assert.equal(openSession(dir, 'abc').latest('snapshot:prod').data.id, 'prod-1');
  assert.equal(openSession(dir, 'other').latest('snapshot:prod'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
