// Interprets parsed shell commands: which ones are infractl or git, and which
// files a tool call would write or delete.

import { commandName } from './shell.mjs';
import { parseArgs, UsageError } from '../../../example-infra/args.mjs';

// The guard recognises `infractl ...` and `node path/to/infractl.mjs ...`.
// Any other route to the CLI (an alias, a wrapper script) is invisible.
export function infractlArgs(argv) {
  const name = commandName(argv[0]);
  if (name === 'infractl' || name === 'infractl.mjs') return argv.slice(1);
  if (name === 'node') {
    const script = argv.findIndex((a, i) => i > 0 && !a.startsWith('-'));
    if (script > 0 && /^infractl(\.mjs)?$/.test(commandName(argv[script]))) return argv.slice(script + 1);
  }
  return null;
}

export function infractlInvocations(call) {
  const found = [];
  for (const { argv } of call.commands) {
    const args = infractlArgs(argv);
    if (!args) continue;
    try {
      found.push(parseArgs(args));
    } catch (err) {
      // The CLI rejects these arguments too, so the command does nothing.
      if (!(err instanceof UsageError)) throw err;
    }
  }
  return found;
}

const GIT_OPTS_WITH_VALUE = new Set(['-c', '--git-dir', '--work-tree', '--namespace']);

// { dir, sub, args } for a git command, handling `git -C <dir>` and other
// global options that come before the subcommand.
export function parseGit(argv) {
  if (commandName(argv[0]) !== 'git') return null;
  let dir = null;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-C') dir = dir ? `${dir}/${argv[++i]}` : argv[++i];
    else if (GIT_OPTS_WITH_VALUE.has(a)) i++;
    else if (!a.startsWith('-')) break;
  }
  return { dir, sub: argv[i] ?? null, args: argv.slice(i + 1) };
}

const NOT_FILES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', 'nul']);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);

// Every file a tool call would write or delete: [{ path, kind, via }].
// A guard that only watches the Edit tool lets the same change through via
// Write, MultiEdit, or `sed -i`, so all of them are covered here.
export function fileTargets(call) {
  const { tool, input } = call;
  if (tool === 'Write') return [{ path: input.file_path, kind: 'write', via: 'Write' }];
  if (tool === 'Edit' || tool === 'MultiEdit') return [{ path: input.file_path, kind: 'write', via: tool }];
  if (tool === 'NotebookEdit') return [{ path: input.notebook_path, kind: 'write', via: tool }];
  if (tool !== 'Bash') return [];

  const targets = [];
  const add = (path, kind, via) => {
    if (path && !NOT_FILES.has(path.toLowerCase())) targets.push({ path, kind, via });
  };

  for (const { argv, redirects } of call.commands) {
    for (const r of redirects) if (WRITE_REDIRECTS.has(r.op)) add(r.target, 'write', `redirect ${r.op}`);

    const name = commandName(argv[0]);
    const args = argv.slice(1);
    const operands = args.filter(a => !a.startsWith('-'));
    switch (name) {
      case 'tee':
      case 'touch':
        operands.forEach(p => add(p, 'write', name));
        break;
      case 'truncate':
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-s' || args[i] === '-r') i++;
          else if (!args[i].startsWith('-')) add(args[i], 'write', name);
        }
        break;
      case 'cp':
      case 'mv':
      case 'install':
        copyTargets(args).forEach(p => add(p, 'write', name));
        break;
      case 'sed':
        sedInPlaceFiles(args).forEach(p => add(p, 'write', 'sed -i'));
        break;
      case 'dd':
        args.filter(a => a.startsWith('of=')).forEach(a => add(a.slice(3), 'write', 'dd'));
        break;
      case 'rm':
        operands.forEach(p => add(p, 'delete', 'rm'));
        break;
    }
  }
  return targets;
}

// The destination, plus destination/<source name> for each source, since
// `cp x.pem dir/` creates dir/x.pem.
function copyTargets(args) {
  const t = args.indexOf('-t');
  const operands = args.filter((a, i) => !a.startsWith('-') && (t < 0 || i !== t + 1));
  const dest = t >= 0 ? args[t + 1] : operands.pop();
  if (!dest) return [];
  return [dest, ...operands.map(src => `${dest.replace(/[\\/]$/, '')}/${src.split(/[\\/]/).pop()}`)];
}

function sedInPlaceFiles(args) {
  let inPlace = false;
  let explicitScript = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') {
      explicitScript = true;
      i++;
    } else if (a.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(a)) {
      inPlace = true;
    } else if (!a.startsWith('-')) {
      operands.push(a);
    }
  }
  if (!inPlace) return [];
  return explicitScript ? operands : operands.slice(1);
}
