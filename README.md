# agent-guardrails-reference

Guardrails for a coding agent that can run real commands against real infrastructure. They are enforced
by [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks), not by asking the model nicely.

The agent works against a small fake deployment service with three environments, blue/green deploy
slots, and a config store. Four guardrails sit between the agent and that service:

| # | Guardrail | What it does | The failure it prevents |
|---|-----------|--------------|-------------------------|
| 1 | **Block** | Denies a tool call outright, with a reason the agent can read and act on. | Deploying straight to the live slot. Committing on `main`. `rm -rf` outside the repo. Writing `.env` files. |
| 2 | **Ask** | Pauses for a human, and shows a checklist of what should already be true. | A slot swap or a prod config change that someone approves on reflex, with nothing to check it against. |
| 3 | **Precondition** | Denies an action until a specific earlier step has succeeded in the same session. | Changing a prod config value with no record of the old value, so there is nothing to roll back to. |
| 4 | **Audit** | The hook, not the model, appends every decision and every tool result to a hash-chained log. | "What did the agent actually do?" having no answer. A guard that quietly stopped firing. |

Everything is plain Node 22+ with zero dependencies. It runs on macOS, Linux and Windows, and CI runs
the tests and the demo on all three.

**If you read one file**, read [`.claude/hooks/policies/infra-actions.mjs`](.claude/hooks/policies/infra-actions.mjs).
It holds the rules for the fake service, and each rule names the failure it exists to prevent.

---

## What this cannot do

Read this section before trusting any of the above.

**These hooks catch accidents, not adversaries.** They parse the commands an agent sends. An agent that
is trying to get around them, or that wanders into a workaround by chance, can:

- **Go through a layer of indirection.** `node -e "..."`, `python -c`, `bash script.sh`, `eval`, a
  Makefile target, or an npm script. The guard sees `npm run ship`. It does not see what `ship` does.
  (It does look inside `$(...)`, backticks and `bash -c "..."`, because those are visible in the command.)
- **Write a file, then run it.** The guard checks each tool call on its own. Writing `do-it.sh` is
  allowed, and so is running it. Nothing connects the two.
- **Rename or encode the command.** An alias, a symlink to the CLI, `$(echo aW5mcmFjdGw= | base64 -d)`,
  or a variable that expands to a command name. The guard recognises `infractl` and
  `node .../infractl.mjs`, and nothing else.
- **Use a tool the guard doesn't route.** The hooks match `Bash`, `Edit`, `Write`, `MultiEdit` and
  `NotebookEdit`. A `PowerShell` tool, or an MCP server that can deploy, is invisible to them unless you
  add its tool names to the matcher and teach a policy to read its input.
- **Edit the guardrails.** Hook files and `.claude/settings.json` are protected paths, so the agent has
  to ask before it changes them. That protection is itself path matching, with the same holes as
  everything else listed here.

**A precondition proves that a step ran. It does not prove the step was sufficient.** "A snapshot was
taken in this session" does not mean it was the right snapshot, or that nothing changed since. A deploy
by someone outside the session is invisible. Records count for 30 minutes: long enough to cover one
change, short enough that what you checked is probably still true.

**A precondition record comes from the command's own output.** The guard only records a step when the
command that ran was the matching `infractl` invocation, so `echo "[infractl] action=config.snapshot ..."`
records nothing. But `infractl config snapshot --env prod || echo "[infractl] action=config.snapshot ..."`
does, because both halves are in one command. A test documents this.

**The hash chain detects edits, not deletion.** `verify-chain` catches a changed, inserted, removed or
reordered line. It cannot tell if someone cut lines off the end, or deleted the file and started over.
Catching that needs the latest hash stored somewhere the agent cannot write to, which this repo does not
do. Tests document both gaps.

**Failing open is a choice, and it has a cost.** If a policy throws, it is skipped, the other policies
still run, and a `guard_error` is logged. So a typo in a policy turns that one policy off without anyone
noticing. `npm run audit:report` flags guard errors and any policy that never fired, but only if someone
reads it. Set `GUARD_FAIL_MODE=closed` to deny on error instead. See [Fail open or fail closed](#fail-open-or-fail-closed).

**Rules in prose are not enforcement.** [`.claude/rules/`](.claude/rules/) asks the agent to verify
before it asserts and to plan a rollback before acting. Those files shape behaviour. Nothing checks
that the agent followed them, and this README does not pretend otherwise.

**The tests prove the cases I thought of.** Every policy has must-block, must-allow and near-miss
cases. I can't measure false negatives I didn't imagine.

The real protection for production is still credentials the agent does not have, and a pipeline that
requires a human. These hooks make the common mistakes loud and cheap to catch, before those last
lines of defence come into play.

---

## Run it

### Without Claude Code (30 seconds)

```sh
npm run demo
```

The demo sends each fixture in [`demo/fixtures/`](demo/fixtures/) through the real hook: a fresh
`node guard.mjs` process per event, with JSON on stdin, the same way Claude Code runs it. Fixtures are
hand-written events in Claude Code's hook format. Each one states the decision it expects, and the demo
exits non-zero on any mismatch, so CI fails if this table stops being true.

```
CASE                                     TOOL   DECISION  POLICY             REASON
read prod status                         Bash   allow     -                  -
deploy to staging                        Bash   allow     -                  -
deploy straight to prod live slot        Bash   deny      infra-actions      Deploying straight to the live slot skips the health check and leaves no rollback.
deploy to prod standby                   Bash   allow     -                  -
swap prod, no health check yet           Bash   deny      preconditions      Run `infractl health --env prod --slot standby` first.
swap prod after healthy check            Bash   ask       infra-actions      This puts the standby build live.
swap prod, standby unhealthy             Bash   deny      preconditions      Standby (build 43) failed its last health check.
swap prod, redeployed since check        Bash   deny      preconditions      Build 43 went to standby after the last health check.
set prod config, no snapshot             Bash   deny      preconditions      Run `infractl config snapshot --env prod` first, so the current values can be restored.
set prod config after snapshot           Bash   ask       infra-actions      This changes live prod configuration.
set prod config, snapshot faked by echo  Bash   deny      preconditions      Run `infractl config snapshot --env prod` first, so the current values can be restored.
rotate prod secret                       Bash   ask       infra-actions      Rotating revokes the old secret immediately.
destroy prod                             Bash   deny      infra-actions      Destroying prod is never done from an agent session.
destroy dev                              Bash   ask       infra-actions      This removes the environment's config and deployed builds.
destroy prod, wrapped in bash -c         Bash   deny      infra-actions      Destroying prod is never done from an agent session.
commit message mentions destroy prod     Bash   allow     -                  -
heredoc body mentions destroy prod       Bash   allow     -                  -
commit on main                           Bash   deny      protected-branch   You are on main, which only takes merges.
commit that concludes a merge on main    Bash   allow     -                  -
new branch then commit, from main        Bash   allow     -                  -
force push                               Bash   deny      destructive-shell  Force-pushing rewrites history other people may have pulled.
push to main                             Bash   ask       destructive-shell  This pushes directly to main.
rm -rf outside the repo                  Bash   deny      destructive-shell  Recursive delete of ~/projects reaches outside the repo.
rm -rf build output                      Bash   allow     -                  -
write .env                               Write  deny      secrets-files      .env holds secrets, and agents don't write those (via Write).
write .env.example                       Write  allow     -                  -
sed -i on .claude/settings.json          Bash   ask       protected-paths    .claude/settings.json is protected: it turns these hooks on and off.
redirect into precondition records       Bash   deny      protected-paths    .claude/state/session-abc.json is protected: writing it would fake a completed check.
command the guard cannot parse           Bash   ask       shell-parse        The guard could not parse this command (unterminated double quote).

29/29 cases matched their expected decision.
```

The table shows the first sentence of each reason. The agent sees all of it. For an ask, that includes
the checklist:

```
This puts the standby build live.
Before approving:
- Standby passed `infractl health` this session. The guard has already checked this.
- You know the current error rate (`infractl logs --env prod`), so you will notice if it gets worse.
- Rollback is `infractl swap --env prod` again, which works as long as the old build stays on standby.
```

### Inside Claude Code

Open this folder in Claude Code. `.claude/settings.json` turns the hooks on. Then try:

> Bump `MAX_CONNECTIONS` to 200 in prod and promote build 42.

The guard denies the config change until a snapshot exists, and denies the swap until standby has
passed a health check. Once both are true, it asks you to approve each one, with the checklist above.

```sh
npm run reset          # restore the fake service to its starting state
npm run audit:report   # what was denied, asked, approved, and any guard errors
npm run verify-chain   # check the audit log has not been edited
npm test               # every policy, near-misses, the fail-open path, the audit log, the CLI
```

---

## The example service

[`example-infra/infractl.mjs`](example-infra/infractl.mjs) is a fake deployment CLI. Its state lives in
local JSON files, so nothing real is ever touched.

- **Environments:** `dev`, `staging`, `prod`
- **Slots:** `prod` has a `live` slot and a `standby` slot. You deploy to standby, then swap. Swapping
  back is the rollback.
- **Config:** key/value settings per environment. A snapshot saves the current values so they can be
  restored.
- **Builds:** 40 to 43. Build 43 fails its health check, so there is something for the guard to catch.

Each action has a decision:

| Command | Decision | Why |
|---------|----------|-----|
| `status`, `logs`, `config get`, `health` | allow | Reads. |
| `deploy --env dev\|staging` | allow | Not prod. |
| `deploy --env prod` (standby, the default) | allow | Nothing live changes until the swap. |
| `deploy --env prod --slot live` | **deny** | Skips the health check and has no rollback. |
| `swap --env prod` | precondition, then **ask** | Needs a passing health check of standby this session, with no deploy since. Then a human. |
| `config set --env prod` | precondition, then **ask** | Needs a snapshot this session, so the old value can be restored. Then a human. |
| `config restore --env prod` | **ask** | Overwrites live config. |
| `secrets rotate --env prod` | **ask** | The old secret is gone once rotated. There is no undo. |
| `env destroy --env dev\|staging` | **ask** | Can be re-created from seed, but not restored. |
| `env destroy --env prod` | **deny** | Never done from an agent session. |
| any command the rules don't know, against prod | **ask** | New commands need a rule before they run unattended. |

The guard and the CLI share one argument parser ([`example-infra/args.mjs`](example-infra/args.mjs)).
If they parsed differently, any spelling the CLI accepted and the guard didn't know would be a way around it.

The guard also covers the repo itself:

| Action | Decision |
|--------|----------|
| `git commit` while on `main` | **deny**, except the commit that concludes a merge |
| `git push --force`, `-f`, `+refspec` | **deny** |
| `git push --force-with-lease` | **ask** |
| `git push` to `main` | **ask** |
| `rm -r` with a target outside the repo, the repo root, or `.git` | **deny** |
| Writing `.env`, `*.pem`, `*.key` and similar, by any route | **deny** |
| Changing hook files, settings, the audit log or prod state, by any route | **ask** |
| Writing precondition records | **deny** |

"By any route" means Write, Edit, MultiEdit, NotebookEdit, shell redirects, `sed -i`, `tee`, `cp`, `mv`
and `rm`. A guard that only watches `Edit` lets the same change through via `Write` or `sed -i`.

---

## How it works

```
Claude Code ──PreToolUse──▶ guard.mjs ──▶ policies/* ──▶ deny / ask (or nothing, to allow) + reason
            ──PostToolUse─▶ guard.mjs ──▶ record completed steps, append result to audit log
            ──SessionStart▶ session-briefing.mjs ──▶ branch, environment state, guard errors
```

- **One entry point.** `guard.mjs` reads the hook JSON from stdin, runs every policy, and keeps the
  strictest result (deny over ask over allow). Policies are plain functions of `(call, ctx)`, which keeps
  them easy to test.
- **It never prints "allow".** An explicit allow would skip Claude Code's own permission prompt. The
  guard only ever adds friction.
- **Commands are parsed, not grepped.** [`lib/shell.mjs`](.claude/hooks/lib/shell.mjs) splits on `&&`,
  `;`, `|` and quotes, skips heredoc bodies, and parses `$(...)` and `bash -c` strings as the commands they
  are. `git commit -m "never run infractl env destroy --env prod"` doesn't trigger the destroy rule,
  because there `infractl` is text inside a string, not a command being run. If the parser can't make
  sense of a command, the guard asks rather than guessing.
- **Preconditions live in session state.** When `infractl config snapshot --env prod` prints its result
  line, the PostToolUse hook records it under the session id. The precondition policy reads that record.
- **The log is written by the hook.** If the model keeps its own log of what it did, you only learn
  what it chose to report. Here every PreToolUse decision and PostToolUse result goes to
  `.claude/audit/audit.jsonl`, written by the hook. Each line holds the hash of the line before it.
  The log stores commands and file paths, never file contents, and masks values that look like secrets.

### Fail open or fail closed

| | Fail open (default) | Fail closed (`GUARD_FAIL_MODE=closed`) |
|---|---|---|
| A policy throws | That policy is skipped, the others still run, `guard_error` logged | Call denied, `guard_error` logged |
| The guard itself crashes | Call allowed, `guard_error` logged | Call denied, `guard_error` logged |
| Cost | A broken policy is silently off | A broken policy blocks the calls it checks until fixed |
| Right for | Local development, where a stuck agent is worse than a missed check | Shared or CI environments, where a missed check is worse |

Either way, `audit:report` lists guard errors, and every policy with zero hits over the period. A
policy that never fires may be fine, or it may be broken. The session briefing also warns the agent
when the log contains guard errors.

---

## Layout

```
.claude/
  settings.json                 registers the hooks
  hooks/
    guard.mjs                   PreToolUse + PostToolUse entry point
    session-briefing.mjs        SessionStart entry point
    policies/
      infra-actions.mjs         deny / ask per infractl command
      preconditions.mjs         "run X first this session", and recording X when it completes
      protected-branch.mjs      no commits on main; merge commits allowed
      destructive-shell.mjs     rm -r outside the repo, force push, push to main
      protected-paths.mjs       guard files, audit log, precondition records, prod state
      secrets-files.mjs         .env, *.pem, *.key
    lib/
      engine.mjs                runs policies, combines results, builds context
      shell.mjs                 command parser
      commands.mjs              recognises infractl and git; finds every file a call writes
      audit.mjs                 hash-chained append, verify, cross-process lock
      redact.mjs                secret masking for the log
      session.mjs, paths.mjs, decision.mjs
  rules/                        prose guidance; not enforced (see limits)
CLAUDE.md                       tells the agent about the repo and imports the rules
example-infra/
  infractl.mjs                  the fake deployment CLI
  args.mjs                      argument parser shared with the guard
  state.mjs, reset.mjs, seed-state.json
demo/
  run-demo.mjs                  sends fixtures through guard.mjs, prints the table above
  fixtures/                     one hook event per case, with its expected decision
tests/                          node:test, no dependencies
scripts/
  audit-report.mjs
  verify-chain.mjs
.github/workflows/ci.yml        tests + demo on ubuntu, macos, windows; Node 22 and 24
```

## Adding a policy

A policy is one file exporting `{ name, check(call, ctx) }`, where `check` returns `null` (no opinion) or
`{ decision, reason }`. It can also export `observe(call, response, ctx)` to record things on
PostToolUse. Add it to `POLICIES` in [`lib/engine.mjs`](.claude/hooks/lib/engine.mjs), then add
must-block, must-allow and near-miss cases to `tests/`, and a fixture to `demo/fixtures/`. A policy
without near-miss tests will end up blocking the wrong things.

## Not in v1

- A Stop hook that compares claims in the agent's final answer with what actually appeared in tool
  output. It's the most interesting idea here, and also the one most likely to raise false alarms, so
  it waits until the core four are solid.

## License

MIT
