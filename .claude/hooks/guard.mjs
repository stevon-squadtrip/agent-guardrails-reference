#!/usr/bin/env node
// Claude Code hook for PreToolUse and PostToolUse.
//
// Reads the hook event from stdin, runs the policies, prints the decision,
// and appends what happened to the audit log. It always exits 0: the decision
// is carried in the JSON output, not the exit code.

import * as audit from './lib/audit.mjs';
import {
  toCall, evaluate, observe, createContext, auditFileFor,
  summarizeInput, summarizeResponse, readStdin,
} from './lib/engine.mjs';

const failMode = process.env.GUARD_FAIL_MODE === 'closed' ? 'closed' : 'open';
let input = null;

try {
  input = JSON.parse(await readStdin());
  const ctx = createContext(input);
  if (input.hook_event_name === 'PreToolUse') pre(input, ctx);
  else if (input.hook_event_name === 'PostToolUse') post(input, ctx);
} catch (err) {
  log(input, { event: 'guard_error', policy: 'guard', error: String(err?.stack ?? err) });
  if (failMode === 'closed' && (input?.hook_event_name ?? 'PreToolUse') === 'PreToolUse') {
    emit('deny', 'The guard itself failed, and GUARD_FAIL_MODE=closed. Run `npm run audit:report` to see the error.');
  }
}

function pre(input, ctx) {
  const call = toCall(input);
  const result = evaluate(call, ctx);
  for (const e of result.errors) log(input, { event: 'guard_error', policy: e.policy, error: e.error });
  log(input, {
    event: 'pre',
    tool: call.tool,
    input: summarizeInput(call),
    decision: result.decision,
    ...(result.policies.length && { policies: result.policies, reason: result.reason }),
  });
  if (result.decision !== 'allow') emit(result.decision, result.reason);
}

function post(input, ctx) {
  const call = toCall(input);
  const { recorded, errors } = observe(call, input.tool_response, ctx);
  if (recorded.length) ctx.session.save();
  for (const e of errors) log(input, { event: 'guard_error', policy: e.policy, error: e.error });
  log(input, {
    event: 'post',
    tool: call.tool,
    input: summarizeInput(call),
    response: summarizeResponse(input.tool_response),
    ...(recorded.length && { recorded }),
  });
}

// "allow" is never printed. An explicit allow would skip Claude Code's own
// permission prompt, and the guard should only ever add friction.
function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
}

// A failure to write the log must not change the decision.
function log(input, entry) {
  try {
    audit.append(auditFileFor(input), {
      session: input?.session_id,
      ...(input?.tool_use_id && { tool_use_id: input.tool_use_id }),
      ...entry,
    });
  } catch (err) {
    process.stderr.write(`guard: could not write audit log: ${err.message}\n`);
  }
}
