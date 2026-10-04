// Per-session records of steps that completed ("snapshot taken at T").
// Preconditions read these; PostToolUse writes them.

import fs from 'node:fs';
import path from 'node:path';

export function openSession(stateDir, sessionId) {
  const safeId = String(sessionId ?? 'unknown').replace(/[^\w.-]/g, '_');
  const file = path.join(stateDir, `session-${safeId}.json`);
  let records = [];
  try {
    records = JSON.parse(fs.readFileSync(file, 'utf8')).records ?? [];
  } catch {
    // No file yet: a new session.
  }
  return makeSession(records, () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ records }, null, 2));
  });
}

export function memorySession(records = []) {
  return makeSession(records, () => {});
}

function makeSession(records, persist) {
  return {
    records,
    latest(key) {
      for (let i = records.length - 1; i >= 0; i--) if (records[i].key === key) return records[i];
      return null;
    },
    add(key, data, ts) {
      records.push({ key, ts, data });
    },
    save: persist,
  };
}
