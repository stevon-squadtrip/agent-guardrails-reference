// Argument parser shared by infractl and the guard.
//
// If the guard parsed arguments differently from the CLI, any spelling the
// CLI accepted but the guard didn't recognise (say `-e prod`) would be a way
// around the rules. One parser means both sides agree on what a command does.

export const ENVIRONMENTS = ['dev', 'staging', 'prod'];

const TWO_LEVEL = new Set(['config', 'secrets', 'env']);
const VALUE_FLAGS = new Set(['env', 'slot', 'build', 'snapshot']);

export class UsageError extends Error {}

export function parseArgs(args) {
  const positional = [];
  const flags = {};
  const assignments = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = arg.match(/^--([a-z]+)(?:=(.*))?$/);
    if (flag) {
      if (!VALUE_FLAGS.has(flag[1])) throw new UsageError(`unknown flag --${flag[1]}`);
      const value = flag[2] ?? args[++i];
      if (value === undefined) throw new UsageError(`--${flag[1]} needs a value`);
      flags[flag[1]] = value;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown flag ${arg}`);
    } else if (/^[A-Z][A-Z0-9_]*=/.test(arg)) {
      const eq = arg.indexOf('=');
      assignments[arg.slice(0, eq)] = arg.slice(eq + 1);
    } else {
      positional.push(arg);
    }
  }

  const [first = '', second = ''] = positional;
  const twoLevel = TWO_LEVEL.has(first);
  return {
    action: twoLevel ? `${first}.${second}` : first,
    operands: positional.slice(twoLevel ? 2 : 1),
    flags,
    assignments,
  };
}

// Prod deploys land on standby unless told otherwise. Every other
// environment has a single live slot.
export function defaultSlot(action, env) {
  if (action === 'deploy' && env === 'prod') return 'standby';
  return 'live';
}
