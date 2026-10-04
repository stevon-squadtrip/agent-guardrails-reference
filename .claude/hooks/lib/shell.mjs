// Splits a shell command into the simple commands it would actually run, so
// policies look at what executes instead of grepping the raw string.
//
// Handles: quotes and escapes, comments, && || ; | &, subshell parens,
// redirects, heredoc bodies (skipped, they are data), $(...) and backticks
// (parsed as nested commands, because they run), `bash -c "..."`, leading
// VAR=value assignments, and wrappers such as sudo, env and xargs.
//
// Does not handle: aliases, functions, variable expansion, globbing, or
// anything a script does once it is running. The README's "What this cannot
// do" section is the list of consequences.

export class ShellParseError extends Error {}

const NESTED_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const MAX_DEPTH = 4;

// Options that consume the next word, per wrapper. Everything else starting
// with "-" is treated as a flag on its own.
const WRAPPERS = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U']),
  env: new Set(['-u', '-C', '-S']),
  command: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  time: new Set(['-f', '-o']),
  nice: new Set(['-n']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']),
};

const REDIRECT = /^(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/;
const OPERATOR = /^(&&|\|\||\|&|;;|[;|&()])/;

// Returns [{ argv, redirects: [{ fd, op, target }] }], one per simple command,
// including commands nested in substitutions and `sh -c` strings.
export function parseCommand(src) {
  return collect(src, 0);
}

export function commandName(word) {
  if (!word) return '';
  return word.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

function collect(src, depth) {
  if (depth > MAX_DEPTH) throw new ShellParseError('commands nested too deeply');
  const { tokens, substitutions } = lex(src);
  const commands = split(tokens);
  const all = [...commands];
  for (const inner of substitutions) all.push(...collect(inner, depth + 1));
  for (const { argv } of commands) {
    if (!NESTED_SHELLS.has(commandName(argv[0]))) continue;
    const c = argv.findIndex((a, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(a));
    if (c > 0 && argv[c + 1] !== undefined) all.push(...collect(argv[c + 1], depth + 1));
  }
  return all;
}

function lex(src) {
  const tokens = [];
  const substitutions = [];
  const heredocs = [];
  let word = null;
  let i = 0;

  const startWord = () => (word ??= { value: '', quoted: false });
  const endWord = () => {
    if (word) tokens.push({ type: 'word', ...word });
    word = null;
  };

  while (i < src.length) {
    const c = src[i];

    if (c === "'") {
      startWord().quoted = true;
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new ShellParseError('unterminated single quote');
      word.value += src.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      startWord().quoted = true;
      i = readDoubleQuoted(src, i + 1, word, substitutions);
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') startWord().value += src[i + 1] ?? '';
      i += 2;
    } else if (c === '$' && src[i + 1] === '(') {
      const end = matchParen(src, i + 2);
      substitutions.push(src.slice(i + 2, end));
      startWord().value += src.slice(i, end + 1);
      i = end + 1;
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) throw new ShellParseError('unterminated backtick');
      substitutions.push(src.slice(i + 1, end));
      startWord().value += src.slice(i, end + 1);
      i = end + 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '\n') {
      endWord();
      tokens.push({ type: 'op', value: ';' });
      i = skipHeredocBodies(src, i + 1, heredocs);
    } else if (c === '#' && !word) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      let fd = null;
      if (word && !word.quoted && /^\d+$/.test(word.value)) {
        fd = word.value;
        word = null;
      } else {
        endWord();
      }
      const op = src.slice(i).match(REDIRECT)[0];
      i += op.length;
      tokens.push({ type: 'redir', op, fd });
      if (op === '<<' || op === '<<-') {
        const delim = readHeredocDelimiter(src, i);
        heredocs.push({ delim: delim.word, stripTabs: op === '<<-' });
        tokens.push({ type: 'word', value: delim.word, quoted: false });
        i = delim.end;
      }
    } else {
      const op = src.slice(i).match(OPERATOR);
      if (op) {
        endWord();
        tokens.push({ type: 'op', value: op[0] });
        i += op[0].length;
      } else {
        startWord().value += c;
        i++;
      }
    }
  }
  endWord();
  return { tokens, substitutions };
}

function readDoubleQuoted(src, i, word, substitutions) {
  while (i < src.length && src[i] !== '"') {
    const c = src[i];
    if (c === '\\' && '"\\$`\n'.includes(src[i + 1])) {
      word.value += src[i + 1];
      i += 2;
    } else if (c === '$' && src[i + 1] === '(') {
      const end = matchParen(src, i + 2);
      substitutions.push(src.slice(i + 2, end));
      word.value += src.slice(i, end + 1);
      i = end + 1;
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) throw new ShellParseError('unterminated backtick');
      substitutions.push(src.slice(i + 1, end));
      word.value += src.slice(i, end + 1);
      i = end + 1;
    } else {
      word.value += c;
      i++;
    }
  }
  if (i >= src.length) throw new ShellParseError('unterminated double quote');
  return i + 1;
}

// Finds the ")" closing a "$(" whose contents start at i. Skips quoted text
// and heredoc bodies, since a commit message like "don't" inside a heredoc
// must not be read as an opening quote.
function matchParen(src, i) {
  let depth = 1;
  const heredocs = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) break;
      i = end + 1;
    } else if (c === '"') {
      i = readDoubleQuoted(src, i + 1, { value: '' }, []);
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const stripTabs = src[i + 2] === '-';
      const delim = readHeredocDelimiter(src, i + (stripTabs ? 3 : 2));
      heredocs.push({ delim: delim.word, stripTabs });
      i = delim.end;
    } else if (c === '\n' && heredocs.length) {
      i = skipHeredocBodies(src, i + 1, heredocs);
    } else {
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) return i;
      i++;
    }
  }
  throw new ShellParseError('unterminated $(');
}

function readHeredocDelimiter(src, i) {
  while (src[i] === ' ' || src[i] === '\t') i++;
  const m = src.slice(i).match(/^(['"]?)([^\s'";&|<>()]+)\1/);
  if (!m) throw new ShellParseError('heredoc without a delimiter');
  return { word: m[2], end: i + m[0].length };
}

// Called at the start of the line after a heredoc was opened. Consumes each
// pending body through its delimiter line and returns the index after it.
function skipHeredocBodies(src, i, heredocs) {
  while (heredocs.length) {
    const { delim, stripTabs } = heredocs.shift();
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const lineEnd = nl < 0 ? src.length : nl;
      let line = src.slice(i, lineEnd).replace(/\r$/, '');
      if (stripTabs) line = line.replace(/^\t+/, '');
      i = lineEnd + 1;
      if (line === delim) break;
    }
  }
  return Math.min(i, src.length);
}

function split(tokens) {
  const commands = [];
  let words = [];
  let redirects = [];
  let pending = null;

  const finish = () => {
    if (words.length || redirects.length) commands.push(build(words, redirects));
    words = [];
    redirects = [];
  };

  for (const token of tokens) {
    if (token.type === 'word') {
      if (pending) {
        redirects.push({ ...pending, target: token.value });
        pending = null;
      } else {
        words.push(token);
      }
    } else if (token.type === 'redir') {
      pending = { op: token.op, fd: token.fd };
    } else {
      pending = null;
      finish();
    }
  }
  finish();
  return commands;
}

function build(words, redirects) {
  return { argv: unwrap(words.map(w => w.value)), redirects };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function unwrap(argv) {
  let rest = argv;
  for (;;) {
    while (rest.length && ASSIGNMENT.test(rest[0])) rest = rest.slice(1);
    const name = commandName(rest[0]);
    const takesValue = WRAPPERS[name];
    if (!takesValue) return rest;
    let i = 1;
    while (i < rest.length) {
      const a = rest[i];
      if (a === '--') { i++; break; }
      if (takesValue.has(a)) i += 2;
      else if (a.startsWith('-')) i++;
      else break;
    }
    rest = rest.slice(i);
  }
}
