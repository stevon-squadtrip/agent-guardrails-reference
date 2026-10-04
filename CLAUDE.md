# agent-guardrails-reference

This repo demonstrates guardrails for a coding agent. The hooks in `.claude/hooks/` check every Bash, Edit,
Write, MultiEdit and NotebookEdit call before it runs. When a call is denied, the reason says what to do
instead. Follow it rather than looking for a way around it.

The example service is a fake deployment CLI. Its state is local JSON, so nothing real is affected:

```sh
node example-infra/infractl.mjs status
node example-infra/infractl.mjs help
npm run reset    # restore the starting state
```

@.claude/rules/evidence-before-assertion.md
@.claude/rules/risk-tiers.md
