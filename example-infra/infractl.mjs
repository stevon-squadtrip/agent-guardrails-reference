#!/usr/bin/env node
// A fake deployment CLI. All state is JSON under ./state, so nothing real is
// ever touched.
//
// Every action that completes prints one line starting with "[infractl] ".
// The guard's PostToolUse hook reads that line to record preconditions
// ("standby was health-checked", "a snapshot exists").

import { parseArgs, defaultSlot, ENVIRONMENTS, UsageError } from './args.mjs';
import * as state from './state.mjs';

const USAGE = `usage: infractl <command> [--env dev|staging|prod] [options]

  status                                   all environments, or one with --env
  logs        --env E                      recent request log summary
  health      --env E [--slot live|standby]
  deploy      --env E --build N [--slot S] prod defaults to --slot standby
  swap        --env prod                   standby becomes live, live becomes standby
  config get      --env E [KEY]
  config set      --env E KEY=VALUE ...
  config snapshot --env E                  save current values for restore
  config restore  --env E [--snapshot ID]  defaults to the latest snapshot
  secrets rotate  --env E NAME             revokes the previous version
  env create      --env E
  env destroy     --env E`;

try {
  state.ensure();
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`infractl: ${err.message}\n\n${USAGE}`);
  process.exitCode = 2;
}

function run(argv) {
  const { action, operands, flags, assignments } = parseArgs(argv);
  switch (action) {
    case '':
    case 'help':
      console.log(USAGE);
      return 0;
    case 'status':
      return status(flags.env);
    case 'logs':
      return logs(requireEnv(flags));
    case 'health':
      return health(requireEnv(flags), flags.slot ?? defaultSlot(action));
    case 'deploy':
      return deploy(requireEnv(flags), flags.build, flags.slot);
    case 'swap':
      return swap(requireEnv(flags));
    case 'config.get':
      return configGet(requireEnv(flags), operands[0]);
    case 'config.set':
      return configSet(requireEnv(flags), assignments);
    case 'config.snapshot':
      return configSnapshot(requireEnv(flags));
    case 'config.restore':
      return configRestore(requireEnv(flags), flags.snapshot);
    case 'secrets.rotate':
      return secretsRotate(requireEnv(flags), operands[0]);
    case 'env.create':
      return envCreate(requireEnv(flags));
    case 'env.destroy':
      return envDestroy(requireEnv(flags));
    default:
      throw new UsageError(`unknown command "${action.replace('.', ' ')}"`);
  }
}

function status(only) {
  for (const name of only ? [requireKnown(only)] : ENVIRONMENTS) {
    const env = state.loadEnv(name);
    if (!env) {
      console.log(`${name.padEnd(8)} (destroyed)`);
      continue;
    }
    const slots = Object.entries(env.slots).map(([slot, s]) => `${slot}=build ${s.build}`).join('  ');
    console.log(`${name.padEnd(8)} ${slots}`);
  }
  return 0;
}

function logs(name) {
  const env = load(name);
  const build = env.slots.live.build;
  const healthy = state.loadBuilds()[build].healthy;
  console.log(`${name} live (build ${build}), last 5 minutes:`);
  console.log(`  requests  ${healthy ? 12840 : 3110}`);
  console.log(`  errors    ${healthy ? '0.2%' : '31.0%'}`);
  console.log(`  p95       ${healthy ? '180ms' : '5000ms (timeouts)'}`);
  return 0;
}

function health(name, slot) {
  const env = load(name);
  const build = slotOf(env, name, slot).build;
  const info = state.loadBuilds()[build];
  const result = info.healthy ? 'healthy' : 'unhealthy';
  console.log(`${name} ${slot}: build ${build} is ${result}${info.note ? ` (${info.note})` : ''}`);
  mark({ action: 'health', env: name, slot, build, result });
  return info.healthy ? 0 : 1;
}

function deploy(name, build, slot = defaultSlot('deploy', name)) {
  if (!build) throw new UsageError('deploy needs --build');
  if (!state.loadBuilds()[build]) throw new UsageError(`no build ${build}`);
  const env = load(name);
  slotOf(env, name, slot).build = Number(build);
  state.saveEnv(name, env);
  console.log(`deployed build ${build} to ${name} ${slot}`);
  mark({ action: 'deploy', env: name, slot, build });
  return 0;
}

function swap(name) {
  const env = load(name);
  if (!env.slots.standby) throw new UsageError(`${name} has no standby slot`);
  [env.slots.live, env.slots.standby] = [env.slots.standby, env.slots.live];
  state.saveEnv(name, env);
  console.log(`${name}: build ${env.slots.live.build} is now live, build ${env.slots.standby.build} is on standby`);
  mark({ action: 'swap', env: name, live: env.slots.live.build });
  return 0;
}

function configGet(name, key) {
  const env = load(name);
  for (const [k, v] of Object.entries(env.config)) {
    if (!key || k === key) console.log(`${k}=${v}`);
  }
  return 0;
}

function configSet(name, assignments) {
  const keys = Object.keys(assignments);
  if (!keys.length) throw new UsageError('config set needs at least one KEY=VALUE');
  const env = load(name);
  for (const key of keys) {
    console.log(`${key}: ${env.config[key] ?? '(unset)'} -> ${assignments[key]}`);
    env.config[key] = assignments[key];
  }
  state.saveEnv(name, env);
  mark({ action: 'config.set', env: name, keys: keys.join(',') });
  return 0;
}

function configSnapshot(name) {
  const env = load(name);
  const id = `${name}-${new Date().toISOString().replace(/[-:.]/g, '')}`;
  state.saveSnapshot({ id, env: name, takenAt: new Date().toISOString(), config: env.config });
  console.log(`saved snapshot ${id} (${Object.keys(env.config).length} keys)`);
  mark({ action: 'config.snapshot', env: name, id });
  return 0;
}

function configRestore(name, id) {
  const snapshot = id ? state.loadSnapshot(id) : state.latestSnapshot(name);
  if (!snapshot) throw new UsageError(id ? `no snapshot ${id}` : `no snapshots for ${name}`);
  if (snapshot.env !== name) throw new UsageError(`snapshot ${snapshot.id} is for ${snapshot.env}, not ${name}`);
  const env = load(name);
  env.config = snapshot.config;
  state.saveEnv(name, env);
  console.log(`restored ${name} config from ${snapshot.id}`);
  mark({ action: 'config.restore', env: name, id: snapshot.id });
  return 0;
}

function secretsRotate(name, secret) {
  if (!secret) throw new UsageError('secrets rotate needs a secret name');
  const env = load(name);
  if (!env.secrets[secret]) throw new UsageError(`no secret ${secret} in ${name}`);
  const previous = env.secrets[secret].version;
  env.secrets[secret].version = previous + 1;
  state.saveEnv(name, env);
  console.log(`${name} ${secret}: version ${previous} revoked, version ${previous + 1} active`);
  mark({ action: 'secrets.rotate', env: name, secret });
  return 0;
}

function envCreate(name) {
  if (state.loadEnv(name)) throw new UsageError(`${name} already exists`);
  state.saveEnv(name, state.seedEnv(name));
  console.log(`created ${name} from seed`);
  mark({ action: 'env.create', env: name });
  return 0;
}

function envDestroy(name) {
  load(name);
  state.removeEnv(name);
  console.log(`destroyed ${name}`);
  mark({ action: 'env.destroy', env: name });
  return 0;
}

function requireEnv(flags) {
  if (!flags.env) throw new UsageError('this command needs --env');
  return requireKnown(flags.env);
}

function requireKnown(name) {
  if (!ENVIRONMENTS.includes(name)) throw new UsageError(`unknown environment "${name}"`);
  return name;
}

function load(name) {
  const env = state.loadEnv(name);
  if (!env) throw new UsageError(`${name} is destroyed; run \`infractl env create --env ${name}\``);
  return env;
}

function slotOf(env, name, slot) {
  if (!env.slots[slot]) throw new UsageError(`${name} has no ${slot} slot`);
  return env.slots[slot];
}

function mark(fields) {
  console.log(`[infractl] ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
