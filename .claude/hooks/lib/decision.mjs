export const RANK = { allow: 0, ask: 1, deny: 2 };
export const BY_RANK = ['allow', 'ask', 'deny'];

// The stricter of two policy results; null means "no opinion".
export function stricter(a, b) {
  if (!a) return b;
  if (!b) return a;
  return RANK[b.decision] > RANK[a.decision] ? b : a;
}

export const deny = reason => ({ decision: 'deny', reason });
export const ask = reason => ({ decision: 'ask', reason });
