// "Run X before Y" within one session.
//
// A step counts when infractl printed its own result line for it during this
// session, and the record is younger than ctx.ttlMs (30 minutes by default:
// long enough to cover one change, short enough that what you checked is
// probably still true).
//
// What this proves: the step ran. What it does not prove: that it was the
// right step, or that nothing changed since. A deploy by someone outside this
// session is invisible here.

import { infractlInvocations } from '../lib/commands.mjs';
import { stricter, deny } from '../lib/decision.mjs';

const REQUIREMENTS = [
  {
    action: 'swap',
    env: 'prod',
    prevents: 'Putting a build live that nobody checked.',
    unmet(session, ctx) {
      const check = session.latest('health:prod:standby');
      if (!check) {
        return 'Run `infractl health --env prod --slot standby` first. Swapping puts standby live, so check it before it takes traffic.';
      }
      if (expired(check, ctx)) {
        return `The last standby health check was ${minutesAgo(check, ctx)} minutes ago. Run it again; things change.`;
      }
      if (check.data.result !== 'healthy') {
        return `Standby (build ${check.data.build}) failed its last health check. Deploy a healthy build to standby and check again.`;
      }
      const deploy = session.latest('deploy:prod:standby');
      if (deploy && deploy.ts > check.ts) {
        return `Build ${deploy.data.build} went to standby after the last health check. That check no longer applies, so run it again.`;
      }
      return null;
    },
  },
  {
    action: 'config.set',
    env: 'prod',
    prevents: 'Changing a prod value with nothing to roll back to.',
    unmet(session, ctx) {
      const snap = session.latest('snapshot:prod');
      if (!snap) return 'Run `infractl config snapshot --env prod` first, so the current values can be restored.';
      if (expired(snap, ctx)) {
        return `The last prod snapshot was ${minutesAgo(snap, ctx)} minutes ago, and values may have changed since. Take a fresh one.`;
      }
      return null;
    },
  },
];

const RESULT_LINE = /^\[infractl\] (.+)$/gm;

export default {
  name: 'preconditions',

  check(call, ctx) {
    let result = null;
    for (const inv of infractlInvocations(call)) {
      const req = REQUIREMENTS.find(r => r.action === inv.action && r.env === inv.flags.env);
      const problem = req?.unmet(ctx.session, ctx);
      if (problem) result = stricter(result, deny(problem));
    }
    return result;
  },

  // PostToolUse: record the steps that completed. A result line only counts
  // when the command that ran was the matching infractl invocation, so
  // `echo "[infractl] action=config.snapshot env=prod"` records nothing.
  observe(call, response, ctx) {
    const lines = [...responseText(response).matchAll(RESULT_LINE)].map(m => fields(m[1]));
    const recorded = [];
    for (const inv of infractlInvocations(call)) {
      const line = lines.find(l => l.action === inv.action && l.env === inv.flags.env);
      const key = line && recordKey(line);
      if (!key) continue;
      ctx.session.add(key, line, ctx.now());
      recorded.push(key);
    }
    return recorded;
  },
};

function recordKey(line) {
  switch (line.action) {
    case 'health': return `health:${line.env}:${line.slot}`;
    case 'deploy': return `deploy:${line.env}:${line.slot}`;
    case 'config.snapshot': return `snapshot:${line.env}`;
    default: return null;
  }
}

function fields(text) {
  return Object.fromEntries(text.split(' ').map(pair => {
    const eq = pair.indexOf('=');
    return [pair.slice(0, eq), pair.slice(eq + 1)];
  }));
}

function responseText(response) {
  if (typeof response === 'string') return response;
  return [response?.stdout, response?.output].filter(s => typeof s === 'string').join('\n');
}

function expired(record, ctx) {
  return ctx.now() - record.ts > ctx.ttlMs;
}

function minutesAgo(record, ctx) {
  return Math.round((ctx.now() - record.ts) / 60_000);
}
