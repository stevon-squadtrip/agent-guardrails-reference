// Masks values that look like secrets before they reach the audit log.
// Pattern-based, so it misses secrets with no recognisable shape. That is one
// reason the log stores file paths and sizes, never file contents.

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1[REDACTED]'],
  [/\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|signing[_-]?key)[A-Za-z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]'],
  [/\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\b[A-Za-z0-9+/]{48,}={0,2}/g, '[REDACTED BASE64]'],
];

export function redact(value) {
  if (typeof value === 'string') return PATTERNS.reduce((s, [re, sub]) => s.replace(re, sub), value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}
