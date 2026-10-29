import { createHmac, createHash, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Authentication.
//
// Today: a passcode (ACCESS_CODE) is exchanged for a signed, short-lived
// session token (HMAC-SHA256, stateless).
//
// Later (Shoppybae integration): replace `authenticate()` below so it validates
// your website's real login (cookie/JWT/etc.) and returns that user's id.
// Nothing else in the voice layer needs to change.
// ---------------------------------------------------------------------------

export type Principal = { id: string };

const b64u = (buf: Buffer) => buf.toString("base64url");

export function signSession(secret: string, sub: string, ttlSec: number, nowMs = Date.now()): string {
  const payload = b64u(Buffer.from(JSON.stringify({ sub, exp: Math.floor(nowMs / 1000) + ttlSec })));
  const sig = b64u(createHmac("sha256", secret).update(payload).digest());
  return `v1.${payload}.${sig}`;
}

export function verifySession(secret: string, token: string, nowMs = Date.now()): Principal | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payload, sig] = parts;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.sub !== "string" || typeof data.exp !== "number") return null;
    if (data.exp * 1000 <= nowMs) return null;
    return { id: data.sub };
  } catch {
    return null;
  }
}

export function checkAccessCode(given: string, expected: string): boolean {
  // Hash both so lengths match and comparison is constant-time.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function authenticate(authorizationHeader: string | undefined, sessionSecret: string): Principal | null {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorizationHeader);
  if (!m) return null;
  return verifySession(sessionSecret, m[1]);
}
