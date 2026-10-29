// Simple in-memory fixed-window rate limiter.
// Limitation: counters live in this process only. If you later run several
// server instances, swap this for a shared store (e.g. Redis).

export type LimitResult = { ok: boolean; retryAfterSec: number };

export function createLimiter(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(opts.windowMs, 60_000));
  sweep.unref();

  return {
    check(key: string, now = Date.now()): LimitResult {
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + opts.windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      if (entry.count > opts.max) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
      }
      return { ok: true, retryAfterSec: 0 };
    },
    size: () => hits.size,
    stop: () => clearInterval(sweep),
  };
}
