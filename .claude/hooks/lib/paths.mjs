import path from 'node:path';

const WINDOWS = process.platform === 'win32';

// Resolves a path the way the shell would, for the cases the guard can know
// statically: "~", relative paths, and Git Bash drive paths (/c/Users/...).
export function resolvePath(p, base, home) {
  let s = p;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(home, s.slice(1));
  if (WINDOWS && /^\/[a-zA-Z](\/|$)/.test(s)) s = `${s[1]}:${s.slice(2) || '/'}`;
  return path.resolve(base, s);
}

// Path of abs relative to root with forward slashes, '' for root itself,
// or null when abs is outside root.
export function relativeTo(root, abs) {
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// "**" matches any number of segments (including none), "*" stays within one.
export function globToRegExp(glob) {
  const body = glob
    .split('/**')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('(?:/.*)?');
  return new RegExp(`^${body}$`, WINDOWS ? 'i' : '');
}

export function baseName(p) {
  return p.split(/[\\/]/).pop();
}
