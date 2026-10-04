// What an agent may do to the example deployment service.
//
// Every rule names the failure it exists to prevent. A rule that can't name
// one can't be argued for or against, so it doesn't go in.
//
//   deny  never from an agent session; the reason says what to do instead
//   ask   a human approves, and the prompt lists what should already be true
//
// Commands with no rule are allowed. Ordering requirements ("health check
// before swap") live in preconditions.mjs, and the guard applies whichever
// result is stricter.

import { infractlInvocations } from '../lib/commands.mjs';
import { stricter } from '../lib/decision.mjs';
import { defaultSlot } from '../../../example-infra/args.mjs';

const RULES = [
  {
    match: { action: 'deploy', env: 'prod', slot: 'live' },
    decision: 'deny',
    prevents: 'A build reaching users with no health check and nothing to swap back to.',
    reason:
      'Deploying straight to the live slot skips the health check and leaves no rollback. ' +
      'Deploy to standby (the default for prod), run `infractl health --env prod --slot standby`, ' +
      'then `infractl swap --env prod`.',
  },
  {
    match: { action: 'swap', env: 'prod' },
    decision: 'ask',
    prevents: 'A swap approved on reflex, because the prompt gave the approver nothing to check.',
    reason: 'This puts the standby build live.',
    checklist: [
      'Standby passed `infractl health` this session. The guard has already checked this.',
      'You know the current error rate (`infractl logs --env prod`), so you will notice if it gets worse.',
      'Rollback is `infractl swap --env prod` again, which works as long as the old build stays on standby.',
    ],
  },
  {
    match: { action: 'config.set', env: 'prod' },
    decision: 'ask',
    prevents: 'A prod setting changed with no record of its old value.',
    reason: 'This changes live prod configuration.',
    checklist: [
      'A snapshot was taken this session. The guard has already checked this. Note its id.',
      'You have seen the old and the new value of every key being changed.',
      'Rollback is `infractl config restore --env prod --snapshot <id>`.',
    ],
  },
  {
    match: { action: 'config.restore', env: 'prod' },
    decision: 'ask',
    prevents: 'Restoring the wrong snapshot over a config that was working.',
    reason: 'This overwrites live prod configuration with a snapshot.',
    checklist: [
      'The snapshot is the one taken just before the change you are undoing.',
      'If the current values might still be needed, snapshot them first.',
    ],
  },
  {
    match: { action: 'secrets.rotate', env: 'prod' },
    decision: 'ask',
    prevents: 'An outage from revoking a secret that clients still use.',
    reason: 'Rotating revokes the old secret immediately. There is no undo.',
    checklist: [
      'Every client that uses this secret will pick up the new version.',
      'Someone is watching prod error rates for the next few minutes.',
    ],
  },
  {
    match: { action: 'env.destroy', env: 'prod' },
    decision: 'deny',
    prevents: 'Losing production.',
    reason: 'Destroying prod is never done from an agent session. If it is really intended, a human runs it by hand.',
  },
  {
    match: { action: 'env.destroy' },
    decision: 'ask',
    prevents: 'Destroying a shared environment someone else is using.',
    reason: 'This removes the environment\'s config and deployed builds. It can be re-created from seed, not restored.',
    checklist: ['Nobody else is using this environment right now.'],
  },
];

const KNOWN = new Set([
  '', 'help', 'status', 'logs', 'health', 'deploy', 'swap',
  'config.get', 'config.set', 'config.snapshot', 'config.restore',
  'secrets.rotate', 'env.create', 'env.destroy',
]);

export default {
  name: 'infra-actions',
  check(call) {
    let result = null;
    for (const inv of infractlInvocations(call)) result = stricter(result, decide(inv));
    return result;
  },
};

export function decide({ action, flags }) {
  const env = flags.env;
  const slot = flags.slot ?? defaultSlot(action, env);
  const rule = RULES.find(({ match }) =>
    match.action === action &&
    (!match.env || match.env === env) &&
    (!match.slot || match.slot === slot));

  if (rule) return { decision: rule.decision, reason: format(rule) };

  // When the CLI grows a command the rules don't know about yet, using it
  // against prod needs approval until someone writes its rule.
  if (!KNOWN.has(action) && env === 'prod') {
    return { decision: 'ask', reason: `\`infractl ${action.replace('.', ' ')}\` has no rule in the guard, and it targets prod.` };
  }
  return null;
}

function format(rule) {
  if (!rule.checklist) return rule.reason;
  return `${rule.reason}\nBefore approving:\n${rule.checklist.map(item => `- ${item}`).join('\n')}`;
}
