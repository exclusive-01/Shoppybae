// End-to-end browser test of the REAL page + REAL client code against a LOCAL FAKE Gemini
// WebSocket server. Proves client protocol behaviour; does NOT prove real Gemini works.
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PROJECT = new URL("..", import.meta.url).pathname;
const APP_PORT = 18081;
const FAKE_PORT = 18082;
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

// ---------------- minimal WebSocket server (handshake + text frames) ----------------
const conns = [];
function sendText(sock, str) {
  const payload = Buffer.from(str);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  sock.write(Buffer.concat([header, payload]));
}
function tonePcmBase64(seconds, rate = 24000, hz = 440) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), i * 2);
  return buf.toString("base64");
}

const fake = http.createServer();
fake.on("upgrade", (req, sock) => {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const c = { url: req.url, setup: null, audio: [], closedCode: null, others: [], sock };
  conns.push(c);
  let buf = Buffer.alloc(0);
  let audioCount = 0;
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(total);
      if (op === 8) { c.closedCode = data.length >= 2 ? data.readUInt16BE(0) : 1005; sock.end(); return; }
      if (op !== 1) continue;
      const msg = JSON.parse(data.toString("utf8"));
      if (msg.setup) {
        c.setup = msg.setup;
        sendText(sock, JSON.stringify({ setupComplete: {} }));
      } else if (msg.realtimeInput?.audio) {
        const a = msg.realtimeInput.audio;
        c.audio.push({ mime: a.mimeType, bytes: Buffer.from(a.data, "base64").length });
        audioCount++;
        if (conns.length === 1 && audioCount === 10) {
          sendText(sock, JSON.stringify({ sessionResumptionUpdate: { newHandle: "handle-1", resumable: true } }));
          sendText(sock, JSON.stringify({ serverContent: { inputTranscription: { text: "show me shoes" } } }));
          sendText(sock, JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: tonePcmBase64(0.5) } }] } } }));
          sendText(sock, JSON.stringify({ serverContent: { outputTranscription: { text: "Sure, " } } }));
          sendText(sock, JSON.stringify({ serverContent: { outputTranscription: { text: "one moment." }, turnComplete: true } }));
          setTimeout(() => {
            // second long reply, then interrupt it mid-way
            sendText(sock, JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: tonePcmBase64(3) } }] } } }));
            setTimeout(() => sendText(sock, JSON.stringify({ serverContent: { interrupted: true } })), 400);
          }, 900);
          setTimeout(() => sendText(sock, JSON.stringify({ goAway: { timeLeft: "5s" } })), 2500);
        }
      } else {
        c.others.push(Object.keys(msg));
      }
    }
  });
  sock.on("error", () => {});
});
await new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", r));

// ---------------- start the REAL project server ----------------
const srv = spawn("node", ["src/server.ts"], {
  cwd: PROJECT,
  env: { PATH: process.env.PATH, GEMINI_API_KEY: "FAKE-NOT-A-REAL-KEY-000000", ACCESS_CODE: "test-passcode-1", SESSION_SECRET: "x".repeat(40), PORT: String(APP_PORT) },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 1200));

// ---------------- browser ----------------
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ permissions: ["microphone"], bypassCSP: true });
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.addInitScript((fakePort) => {
  // Redirect the Gemini WebSocket URL to the local fake; keep path + query intact.
  const Real = window.WebSocket;
  window.__wsUrls = [];
  window.WebSocket = function (url, p) {
    window.__wsUrls.push(String(url));
    const u = new URL(url);
    return new Real(`ws://127.0.0.1:${fakePort}${u.pathname}${u.search}`, p);
  };
  Object.assign(window.WebSocket, Real);
  window.WebSocket.prototype = Real.prototype;
  // Count scheduled playback.
  window.__played = { starts: 0, seconds: 0, stops: 0 };
  const S = AudioBufferSourceNode.prototype;
  const start = S.start, stop = S.stop;
  S.start = function (...a) { window.__played.starts++; window.__played.seconds += this.buffer ? this.buffer.duration : 0; return start.apply(this, a); };
  S.stop = function (...a) { window.__played.stops++; return stop.apply(this, a); };
  // Track mic streams.
  window.__streams = [];
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { window.__gumConstraints = c; const s = await gum(c); window.__streams.push(s); return s; };
}, FAKE_PORT);

// Mock ONLY the Gemini-dependent endpoint (real Google is unreachable from this sandbox).
await page.route("**/api/live-token", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      token: "auth_tokens/FAKE-EPHEMERAL-TOKEN",
      model: "models/gemini-3.8-live",
      expireTime: new Date(Date.now() + 20 * 60000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 60000).toISOString(),
      setup: { model: "models/gemini-3.8-live", responseModalities: ["AUDIO"], sessionResumption: {}, inputAudioTranscription: {}, outputAudioTranscription: {} },
    }),
  });
});

await page.goto(`http://127.0.0.1:${APP_PORT}/`);
await page.fill("#code", "wrong-code-123");
await page.click("#login button");
await page.waitForFunction(() => document.getElementById("login-msg").textContent.length > 0);
check("wrong access code is rejected in UI", (await page.textContent("#login-msg")).includes("Wrong"));

await page.fill("#code", "test-passcode-1");
await page.click("#login button");
await page.waitForSelector("#voice:not([hidden])");
check("correct access code unlocks voice UI (real /api/session)", true);

await page.click("#start");
await page.waitForFunction(() => document.getElementById("status").dataset.state === "listening", null, { timeout: 8000 }).catch(() => {});
const stateAfterStart = await page.getAttribute("#status", "data-state");
check("reaches 'listening' after setupComplete", stateAfterStart === "listening" || stateAfterStart === "speaking", `state=${stateAfterStart}`);

await page.waitForTimeout(3200); // let the scripted reply, interruption and goAway happen
for (let i = 0; i < 50 && conns.length < 2; i++) await new Promise((r) => setTimeout(r, 100)); // wait for reconnect (up to 5s)
await page.waitForTimeout(300);
const c1 = conns[0], c2 = conns[1];

check("connected to Constrained endpoint with access_token query", !!c1 && c1.url.includes("BidiGenerateContentConstrained?access_token=auth_tokens%2FFAKE-EPHEMERAL-TOKEN"), c1 && c1.url.split("?")[0].split(".").slice(-2).join("."));
check("first message is setup with model + AUDIO modality", c1?.setup?.model === "models/gemini-3.8-live" && c1.setup.responseModalities?.[0] === "AUDIO");
check("setup does not contain system instruction or any API key", !JSON.stringify(c1?.setup).includes("systemInstruction") && !JSON.stringify(c1?.setup).includes("FAKE-NOT-A-REAL"));
check("mic audio sent as audio/pcm;rate=16000", c1?.audio.length > 5 && c1.audio.every((a) => a.mime === "audio/pcm;rate=16000"), `${c1?.audio.length} chunks`);
check("each chunk is 40 ms of 16-bit PCM (1280 bytes)", c1?.audio.every((a) => a.bytes === 1280), `sizes=${[...new Set(c1?.audio.map((a) => a.bytes))]}`);
check("mic requested with echo cancellation + noise suppression", await page.evaluate(() => window.__gumConstraints?.audio?.echoCancellation === true && window.__gumConstraints?.audio?.noiseSuppression === true));

const played = await page.evaluate(() => window.__played);
check("model audio was scheduled for playback", played.starts >= 2 && played.seconds >= 3, `${played.starts} buffers, ${played.seconds.toFixed(2)}s`);
check("'interrupted' stopped queued playback", played.stops >= 1, `stops=${played.stops}`);

const transcript = await page.$$eval("#transcript li", (els) => els.map((e) => e.className + ": " + e.textContent.replace(/^(You|Assistant)/, "")));
check("transcripts rendered (user + assistant)", transcript.some((t) => t.includes("show me shoes")) && transcript.some((t) => t.includes("Sure, one moment.")), JSON.stringify(transcript));

check("goAway triggered reconnect with resumption handle", !!c2 && c2.setup?.sessionResumption?.handle === "handle-1", c2 ? `handle=${c2.setup?.sessionResumption?.handle}` : "no 2nd connection");
await page.waitForTimeout(800);
check("audio streaming continues after reconnect", (conns[1]?.audio.length ?? 0) > 3, `${conns[1]?.audio.length} chunks`);
const stateAfterReconnect = await page.getAttribute("#status", "data-state");
check("state back to listening after reconnect", ["listening", "speaking"].includes(stateAfterReconnect), stateAfterReconnect);

await page.click("#stop");
await page.waitForTimeout(500);
const after = await page.evaluate(() => ({ live: window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length, state: document.getElementById("status").dataset.state }));
check("End releases the microphone (no live tracks)", after.live === 0, `live=${after.live}`);
check("End closes the WebSocket cleanly (1000)", conns[conns.length - 1]?.closedCode === 1000, `code=${conns[conns.length - 1]?.closedCode}`);
check("UI shows ended state", after.state === "closed");
check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.join(" | "));

// ---- failure paths ----
// 1) mic denied
const ctx2 = await browser.newContext({ permissions: [], bypassCSP: true });
const p2 = await ctx2.newPage();
await p2.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { const e = new Error("denied"); e.name = "NotAllowedError"; throw e; }; });
await p2.route("**/api/live-token", (r) => r.abort());
await p2.goto(`http://127.0.0.1:${APP_PORT}/`);
await p2.fill("#code", "test-passcode-1"); await p2.click("#login button");
await p2.waitForSelector("#voice:not([hidden])"); await p2.click("#start");
await p2.waitForFunction(() => document.getElementById("error").textContent.length > 0);
check("mic permission denied shows clear message", /Microphone permission was denied/.test(await p2.textContent("#error")) && (await p2.getAttribute("#status", "data-state")) === "error");

// 2) token endpoint failure surfaces a readable error
const p3 = await (await browser.newContext({ permissions: ["microphone"], bypassCSP: true })).newPage();
await p3.route("**/api/live-token", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "upstream_auth" }) }));
await p3.goto(`http://127.0.0.1:${APP_PORT}/`);
await p3.fill("#code", "test-passcode-1"); await p3.click("#login button");
await p3.waitForSelector("#voice:not([hidden])"); await p3.click("#start");
await p3.waitForFunction(() => document.getElementById("error").textContent.length > 0);
check("token failure shows readable error and releases mic", /could not authenticate with Gemini/.test(await p3.textContent("#error")));

await browser.close();
srv.kill();
fake.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
