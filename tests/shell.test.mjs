import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCommand, ShellParseError } from '../.claude/hooks/lib/shell.mjs';

const argvs = src => parseCommand(src).map(c => c.argv);

test('splits on && || ; | and newlines', () => {
  assert.deepEqual(argvs('a 1 && b 2 || c; d | e\nf'), [['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f']]);
});

test('quoted text stays one argument and is not a command', () => {
  assert.deepEqual(argvs(`git commit -m "run infractl swap; then rm -rf /"`), [
    ['git', 'commit', '-m', 'run infractl swap; then rm -rf /'],
  ]);
  assert.deepEqual(argvs(`echo 'a && b'`), [['echo', 'a && b']]);
});

test('escapes inside double quotes', () => {
  assert.deepEqual(argvs(`echo "say \\"hi\\" \\$HOME"`), [['echo', 'say "hi" $HOME']]);
});

test('comments are ignored, # inside a word is not a comment', () => {
  assert.deepEqual(argvs('echo a#b # infractl swap --env prod'), [['echo', 'a#b']]);
});

test('heredoc bodies are data, not commands', () => {
  const src = "cat > notes.md <<'EOF'\ninfractl env destroy --env prod\nEOF\necho done";
  assert.deepEqual(argvs(src), [['cat'], ['echo', 'done']]);
});

test('<<- heredoc delimiters may be indented with tabs', () => {
  assert.deepEqual(argvs('cat <<-END\n\tinfractl swap\n\tEND\nls'), [['cat'], ['ls']]);
});

test('command substitution runs, so it is parsed', () => {
  assert.deepEqual(argvs('echo $(infractl status --env prod)'), [
    ['echo', '$(infractl status --env prod)'],
    ['infractl', 'status', '--env', 'prod'],
  ]);
  assert.deepEqual(argvs('echo "`infractl swap`"').at(-1), ['infractl', 'swap']);
});

test('heredoc with an apostrophe inside $( ) does not break quoting', () => {
  const src = `git commit -m "$(cat <<'EOF'\nFix: don't swap (yet)\nEOF\n)"`;
  assert.deepEqual(argvs(src), [['git', 'commit', '-m', src.slice(src.indexOf('"') + 1, -1)], ['cat']]);
});

test('bash -c and sh -lc strings are parsed as commands', () => {
  assert.deepEqual(argvs(`bash -c "infractl swap --env prod"`).at(-1), ['infractl', 'swap', '--env', 'prod']);
  assert.deepEqual(argvs(`sh -lc 'rm -rf /'`).at(-1), ['rm', '-rf', '/']);
});

test('leading assignments and wrappers are stripped', () => {
  assert.deepEqual(argvs('FOO=1 sudo -u ops BAR=2 env -u X nice -n 5 infractl swap'), [['infractl', 'swap']]);
  assert.deepEqual(argvs('ls | xargs -I {} rm -rf {}').at(-1), ['rm', '-rf', '{}']);
});

test('redirects are captured with their targets', () => {
  const [cmd] = parseCommand('echo hi > out.txt 2>&1 >>log.txt');
  assert.deepEqual(cmd.argv, ['echo', 'hi']);
  assert.deepEqual(cmd.redirects.map(r => [r.fd, r.op, r.target]), [
    [null, '>', 'out.txt'],
    ['2', '>&', '1'],
    [null, '>>', 'log.txt'],
  ]);
});

test('unterminated quotes are a parse error, not a guess', () => {
  assert.throws(() => parseCommand('echo "oops'), ShellParseError);
  assert.throws(() => parseCommand("echo 'oops"), ShellParseError);
  assert.throws(() => parseCommand('echo $(oops'), ShellParseError);
});
