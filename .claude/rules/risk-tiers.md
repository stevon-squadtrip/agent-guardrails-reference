# Risk tiers

Guidance, not enforcement. The hooks enforce a subset of this (see README.md); the rest relies on the agent.

| Tier | Examples | What to do |
|------|----------|------------|
| Low | Reads, dev and staging deploys, snapshots, health checks | Go ahead. |
| Medium | Prod standby deploys, staging config changes, destroying dev | Say what you are about to do, and how you would undo it, before doing it. |
| High | Slot swaps, prod config changes, secret rotation | Propose it and stop. A human approves. |

Before any medium or high action, write down:

1. **Before:** the current state, captured with a command (`status`, `config snapshot`).
2. **Change:** the exact command.
3. **After:** how you will check it worked (`health`, `logs`).
4. **Rollback:** the exact command that undoes it. If there isn't one (secret rotation), say so plainly.
