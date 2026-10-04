#!/usr/bin/env node
// Checks that no line in the audit log was edited, inserted or removed.
// Exits 1 if the chain is broken.
//
// It cannot detect lines cut off the end, or the whole file replaced. See
// the header of .claude/hooks/lib/audit.mjs.

import { verify } from '../.claude/hooks/lib/audit.mjs';
import { auditFileFor } from '../.claude/hooks/lib/engine.mjs';

const file = process.argv[2] ?? auditFileFor({ cwd: process.cwd() });
const result = verify(file);

if (result.ok) {
  console.log(`ok: ${result.entries} entries, chain intact (${file})`);
} else {
  console.log(`BROKEN at line ${result.brokenAt} of ${result.entries}: ${result.problem} (${file})`);
  process.exitCode = 1;
}
