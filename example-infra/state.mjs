// JSON file storage for the fake service. One file per environment, so a
// guard can protect prod's file without also protecting dev's.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, 'seed-state.json');

export function stateDir() {
  return process.env.INFRACTL_STATE_DIR ?? path.join(HERE, 'state');
}

export function reset(dir = stateDir()) {
  const seed = readJson(SEED);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  writeJson(path.join(dir, 'builds.json'), seed.builds);
  for (const [name, env] of Object.entries(seed.envs)) writeJson(path.join(dir, `${name}.json`), env);
}

export function seedEnv(name) {
  return readJson(SEED).envs[name];
}

export function ensure(dir = stateDir()) {
  if (!fs.existsSync(path.join(dir, 'builds.json'))) reset(dir);
}

export function loadBuilds(dir = stateDir()) {
  return readJson(path.join(dir, 'builds.json'));
}

export function loadEnv(name, dir = stateDir()) {
  const file = path.join(dir, `${name}.json`);
  return fs.existsSync(file) ? readJson(file) : null;
}

export function saveEnv(name, env, dir = stateDir()) {
  writeJson(path.join(dir, `${name}.json`), env);
}

export function removeEnv(name, dir = stateDir()) {
  fs.rmSync(path.join(dir, `${name}.json`), { force: true });
}

export function saveSnapshot(snapshot, dir = stateDir()) {
  writeJson(path.join(dir, 'snapshots', `${snapshot.id}.json`), snapshot);
}

export function loadSnapshot(id, dir = stateDir()) {
  const file = path.join(dir, 'snapshots', `${id}.json`);
  return fs.existsSync(file) ? readJson(file) : null;
}

export function latestSnapshot(env, dir = stateDir()) {
  const ids = fs.readdirSync(path.join(dir, 'snapshots'))
    .filter(f => f.startsWith(`${env}-`))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
  return ids.length ? loadSnapshot(ids.at(-1), dir) : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
