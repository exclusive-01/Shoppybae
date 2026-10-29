import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { createLogger, registerSecret } from "../src/logger.ts";
import { createApp } from "../src/app.ts";
import { signSession, verifySession } from "../src/auth.ts";
import { createLimiter } from "../src/ratelimit.ts";

const API_KEY = "TEST-GEMINI-KEY-1234567890";
const ACCESS = "correct-horse-battery";
const SECRET = "s".repeat(40);

const baseEnv = { GEMINI_API_KEY: API_KEY, ACCESS_CODE: ACCESS, SESSION_SECRET: SECRET };

// Capture everything the logger prints so we can prove secrets never appear.
function captureLogs() {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => ((console.log = origLog), (console.error = origErr)) };
}

async function startApp(envOver = {}, fetchImpl) {
  const config = loadConfig({ ...baseEnv, ...envOver });
  registerSecret(config.geminiApiKey);
  registerSecret(config.accessCode);
  registerSecret(config.sessionSecret);
  const { server, stop } = createApp(config, createLogger("debug"), { fetchImpl });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, config, close: () => new Promise((r) => (stop(), server.close(r))) };
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });

async function login(base) {
  const r = await post(base + "/api/session", { code: ACCESS });
  return (await r.json()).sessionToken;
}

// A fake Gemini that records what the server sent.
function fakeGemini(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}
const okGemini = () =>
  fakeGemini(async () => new Response(JSON.stringify({ name: "auth_tokens/FAKE-EPHEMERAL-TOKEN-abc123" }), { status: 200 }));

test("config: missing secrets fail fast and error names variables, not values", () => {
  assert.throws(() => loadConfig({}), /GEMINI_API_KEY is missing.*ACCESS_CODE is missing.*SESSION_SECRET is missing/s);
  assert.throws(() => loadConfig({ ...baseEnv, ACCESS_CODE: "short" }), /ACCESS_CODE is too short/);
  assert.throws(() => loadConfig({ ...baseEnv, ALLOWED_ORIGINS: "http://evil.example" }), /must be https/);
  try {
    loadConfig({ ...baseEnv, ACCESS_CODE: "short" });
  } catch (e) {
    assert.ok(!String(e.message).includes(API_KEY));
  }
});

test("auth: session tokens verify, expire and reject tampering", () => {
  const t = signSession(SECRET, "u1", 60, 1_000_000);
  assert.deepEqual(verifySession(SECRET, t, 1_000_000 + 1000), { id: "u1" });
  assert.equal(verifySession(SECRET, t, 1_000_000 + 61_000), null);
  assert.equal(verifySession("x".repeat(40), t, 1_000_000), null);
  const [v, p, s] = t.split(".");
  assert.equal(verifySession(SECRET, `${v}.${p}.${s.slice(0, -2)}AA`, 1_000_000), null);
  assert.equal(verifySession(SECRET, "garbage", 1_000_000), null);
});

test("ratelimit: blocks after max and resets after window", () => {
  const l = createLimiter({ windowMs: 1000, max: 2 });
  assert.ok(l.check("a", 0).ok);
  assert.ok(l.check("a", 1).ok);
  const blocked = l.check("a", 2);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.ok(l.check("a", 1500).ok);
  l.stop();
});

test("token endpoint requires authentication", async () => {
  const fake = okGemini();
  const app = await startApp({}, fake);
  try {
    assert.equal((await post(app.base + "/api/live-token", {})).status, 401);
    assert.equal((await post(app.base + "/api/live-token", {}, { authorization: "Bearer nope" })).status, 401);
    assert.equal(fake.calls.length, 0, "Gemini must not be called for unauthenticated requests");
  } finally {
    await app.close();
  }
});

test("login: wrong code rejected, throttled after repeated failures", async () => {
  const app = await startApp({}, okGemini());
  try {
    for (let i = 0; i < 10; i++) assert.equal((await post(app.base + "/api/session", { code: "wrong-code-123" })).status, 401);
    assert.equal((await post(app.base + "/api/session", { code: ACCESS })).status, 429);
  } finally {
    await app.close();
  }
});

test("token endpoint: issues token, locks model/config, never leaks API key", async () => {
  const fake = okGemini();
  const app = await startApp({}, fake);
  try {
    const session = await login(app.base);
    const r = await post(app.base + "/api/live-token", { profile: "default" }, { authorization: `Bearer ${session}` });
    assert.equal(r.status, 200);
    const raw = await r.text();
    const body = JSON.parse(raw);

    assert.equal(body.token, "auth_tokens/FAKE-EPHEMERAL-TOKEN-abc123");
    assert.equal(body.model, "models/gemini-3.8-live");
    assert.ok(!raw.includes(API_KEY), "API key must never appear in the response");
    assert.ok(!raw.includes("Shoppybae voice assistant"), "system instruction must stay server-side");
    assert.equal(r.headers.get("cache-control"), "no-store");

    // What the server sent to Gemini:
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    assert.equal(call.init.headers["x-goog-api-key"], API_KEY);
    assert.ok(!call.url.includes(API_KEY), "key must not be in the URL");
    const sent = JSON.parse(call.init.body);
    assert.equal(sent.uses, 1);
    assert.equal(sent.liveConnectConstraints.model, "models/gemini-3.8-live");
    assert.deepEqual(sent.liveConnectConstraints.config.responseModalities, ["AUDIO"]);
    assert.ok(sent.liveConnectConstraints.config.systemInstruction.parts[0].text.length > 10);
    const life = new Date(sent.expireTime).getTime() - Date.now();
    assert.ok(life > 10 * 60_000 && life <= 21 * 60_000, "expiry should be ~20 min");
    const win = new Date(sent.newSessionExpireTime).getTime() - Date.now();
    assert.ok(win > 0 && win <= 61_000, "new-session window should be ~1 min");
  } finally {
    await app.close();
  }
});

test("token endpoint: validates profile and body", async () => {
  const app = await startApp({}, okGemini());
  try {
    const auth = { authorization: `Bearer ${await login(app.base)}` };
    assert.equal((await post(app.base + "/api/live-token", { profile: "gemini-evil-model" }, auth)).status, 400);
    const r = await fetch(app.base + "/api/live-token", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{not json" });
    assert.equal(r.status, 400);
    const big = await fetch(app.base + "/api/live-token", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ profile: "x".repeat(5000) }) }).catch(() => null);
    assert.ok(big === null || big.status === 413 || big.status === 400);
    const ct = await fetch(app.base + "/api/live-token", { method: "POST", headers: { "content-type": "text/plain", ...auth }, body: "hi" });
    assert.equal(ct.status, 415);
    assert.equal((await fetch(app.base + "/api/live-token", { headers: auth })).status, 405);
  } finally {
    await app.close();
  }
});

test("token endpoint: rate limited per user", async () => {
  const app = await startApp({}, okGemini());
  try {
    const auth = { authorization: `Bearer ${await login(app.base)}` };
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post(app.base + "/api/live-token", {}, auth)).status;
    assert.equal(last, 429);
  } finally {
    await app.close();
  }
});

test("upstream failures map to safe codes and do not leak details or the key", async () => {
  const cases = [
    [403, "upstream_auth", 502],
    [401, "upstream_auth", 502],
    [429, "upstream_quota", 503],
    [404, "upstream_rejected_request", 502],
    [500, "upstream_error", 502],
  ];
  for (const [status, code, expected] of cases) {
    const fake = fakeGemini(async () => new Response(JSON.stringify({ error: { status: "X", message: `bad key ${API_KEY}` } }), { status }));
    const app = await startApp({}, fake);
    const cap = captureLogs();
    try {
      const auth = { authorization: `Bearer ${await login(app.base)}` };
      const r = await post(app.base + "/api/live-token", {}, auth);
      const raw = await r.text();
      cap.restore();
      assert.equal(r.status, expected);
      assert.equal(JSON.parse(raw).error, code);
      assert.ok(!raw.includes(API_KEY));
      assert.ok(!cap.lines.join("\n").includes(API_KEY), "logs must not contain the API key");
    } finally {
      cap.restore();
      await app.close();
    }
  }
});

test("network failure to Gemini returns 502 without crashing", async () => {
  const fake = fakeGemini(async () => {
    throw new TypeError("fetch failed");
  });
  const app = await startApp({}, fake);
  try {
    const auth = { authorization: `Bearer ${await login(app.base)}` };
    const r = await post(app.base + "/api/live-token", {}, auth);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, "upstream_unreachable");
    assert.equal((await fetch(app.base + "/healthz")).status, 200);
  } finally {
    await app.close();
  }
});

test("logs never contain secrets, session tokens or passcode across a full flow", async () => {
  const cap = captureLogs();
  const app = await startApp({}, okGemini());
  let session;
  try {
    session = await login(app.base);
    await post(app.base + "/api/session", { code: "wrong-wrong-wrong" });
    await post(app.base + "/api/live-token", {}, { authorization: `Bearer ${session}` });
  } finally {
    cap.restore();
    await app.close();
  }
  const all = cap.lines.join("\n");
  for (const secret of [API_KEY, ACCESS, SECRET, session, "wrong-wrong-wrong", "FAKE-EPHEMERAL-TOKEN"]) {
    assert.ok(!all.includes(secret), `log leaked a secret value`);
  }
  assert.ok(all.includes("ephemeral token issued"), "sanity: logs were captured");
});

test("CORS: other origins blocked unless allow-listed; same-origin works", async () => {
  const app = await startApp({ ALLOWED_ORIGINS: "https://www.shoppybae.example" }, okGemini());
  try {
    const evil = await post(app.base + "/api/session", { code: ACCESS }, { origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    const good = await post(app.base + "/api/session", { code: ACCESS }, { origin: "https://www.shoppybae.example" });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("access-control-allow-origin"), "https://www.shoppybae.example");
    const same = await post(app.base + "/api/session", { code: ACCESS }, { origin: app.base });
    assert.equal(same.status, 200);
    const pre = await fetch(app.base + "/api/live-token", { method: "OPTIONS", headers: { origin: "https://www.shoppybae.example" } });
    assert.equal(pre.status, 204);
  } finally {
    await app.close();
  }
});

test("static files: page served with security headers; traversal and unknown types blocked", async () => {
  const app = await startApp({}, okGemini());
  try {
    const home = await fetch(app.base + "/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Shoppybae Voice/);
    assert.match(home.headers.get("content-security-policy"), /connect-src 'self' wss:\/\/generativelanguage\.googleapis\.com/);
    assert.match(home.headers.get("permissions-policy"), /microphone=\(self\)/);
    assert.equal(home.headers.get("x-content-type-options"), "nosniff");

    assert.equal((await fetch(app.base + "/voice/gemini-live-client.js")).status, 200);
    assert.equal((await fetch(app.base + "/voice/capture-worklet.js")).status, 200);

    for (const p of ["/..%2f..%2fpackage.json", "/%2e%2e/package.json", "/../.env.example", "/src/config.ts"]) {
      const r = await fetch(app.base + p);
      assert.ok(r.status === 404 || r.status === 400, `${p} should not be served (got ${r.status})`);
    }
  } finally {
    await app.close();
  }
});

test("the permanent key is not present anywhere in the public folder", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..", "public");
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const text = await readFile(p, "utf8");
        assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(text), `${p} looks like it contains a Google API key`);
        assert.ok(!text.includes("GEMINI_API_KEY"), `${p} must not reference the server secret`);
      }
    }
  };
  await walk(root);
});
