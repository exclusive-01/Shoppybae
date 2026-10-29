// Tiny structured logger. It never prints request bodies or headers, redacts
// sensitive field names, and scrubs any registered secret value from strings.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const SENSITIVE_KEY = /key|token|authorization|secret|code|cookie|password|passcode/i;
const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value && value.length >= 6) secrets.add(value);
}

function scrubString(s: string): string {
  let out = s;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object" || depth > 3) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

export function createLogger(minLevel: Level = "info") {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const line = { t: new Date().toISOString(), level, msg: scrubString(msg), ...(scrub(fields ?? {}) as object) };
    (level === "error" || level === "warn" ? console.error : console.log)(JSON.stringify(line));
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
  };
}

export type Logger = ReturnType<typeof createLogger>;
