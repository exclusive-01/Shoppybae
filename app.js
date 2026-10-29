// Thin demo shell around the reusable voice module. Everything Shoppybae-specific
// will live outside /voice/. This file only wires the buttons.
import { GeminiLiveClient } from "/voice/gemini-live-client.js";

const $ = (id) => document.getElementById(id);
const loginForm = $("login");
const voiceSection = $("voice");
const statusEl = $("status");
const startBtn = $("start");
const stopBtn = $("stop");
const errorEl = $("error");
const transcriptEl = $("transcript");

let sessionToken = null; // kept in memory only
let sessionExpiresAt = 0;

const LABELS = {
  idle: "Ready",
  "requesting-mic": "Waiting for microphone permission…",
  "fetching-token": "Getting a secure voice token…",
  connecting: "Connecting to Gemini Live…",
  listening: "Connected. Listening — go ahead and speak.",
  speaking: "Assistant is speaking…",
  reconnecting: "Connection dropped. Reconnecting…",
  expired: "Session time limit reached. Tap Start to begin a new one.",
  error: "Something went wrong.",
  closed: "Ended.",
};

const ERROR_TEXT = {
  unauthorized: "Your login expired. Please unlock again.",
  rate_limited: "Too many sessions started. Wait a few minutes and try again.",
  upstream_auth: "The server could not authenticate with Gemini. The API key may be missing or invalid.",
  upstream_quota: "Gemini quota or billing limit reached.",
  upstream_rejected_request: "Gemini rejected the session request. The model may not be available to this API key.",
  upstream_timeout: "Gemini took too long to respond.",
  upstream_unreachable: "The server could not reach Gemini.",
};

async function api(path, body, auth) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    const err = new Error(ERROR_TEXT[data.error] || `Request failed (${res.status}).`);
    err.code = data.error || "http_" + res.status;
    err.status = res.status;
    throw err;
  }
  return data;
}

const client = new GeminiLiveClient({
  tokenProvider: async () => {
    if (!sessionToken || Date.now() > sessionExpiresAt) {
      const e = new Error(ERROR_TEXT.unauthorized);
      e.code = "unauthorized";
      throw e;
    }
    return api("/api/live-token", { profile: "default" }, sessionToken);
  },
  onState: (state) => {
    statusEl.dataset.state = state;
    statusEl.textContent = LABELS[state] || state;
    const active = ["requesting-mic", "fetching-token", "connecting", "listening", "speaking", "reconnecting"].includes(state);
    startBtn.disabled = active;
    startBtn.hidden = active;
    stopBtn.hidden = !active;
    if (active) errorEl.textContent = "";
  },
  onError: ({ code, message }) => {
    errorEl.textContent = ERROR_TEXT[code] || message;
    if (code === "unauthorized") {
      sessionToken = null;
      voiceSection.hidden = true;
      loginForm.hidden = false;
    }
  },
  onTranscript: ({ role, text, final }) => {
    let li = transcriptEl.querySelector(`li.${role}[data-open="1"]`);
    if (!li) {
      li = document.createElement("li");
      li.className = role;
      li.dataset.open = "1";
      const label = document.createElement("small");
      label.textContent = role === "user" ? "You" : "Assistant";
      const body = document.createElement("span");
      li.append(label, body);
      transcriptEl.append(li);
    }
    li.lastChild.textContent = text; // textContent only: transcripts are never parsed as HTML
    if (final) delete li.dataset.open;
  },
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("login-msg");
  msg.textContent = "";
  try {
    const r = await api("/api/session", { code: $("code").value });
    sessionToken = r.sessionToken;
    sessionExpiresAt = Date.now() + r.expiresInSec * 1000 - 10000;
    $("code").value = "";
    loginForm.hidden = true;
    voiceSection.hidden = false;
  } catch (err) {
    msg.textContent = err.code === "invalid_code" ? "Wrong access code." : err.code === "too_many_attempts" ? "Too many attempts. Try again later." : err.message;
  }
});

startBtn.addEventListener("click", () => client.start()); // user gesture: required for mic + audio on mobile
stopBtn.addEventListener("click", () => client.stop());
window.addEventListener("pagehide", () => client.stop());
