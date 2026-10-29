// GeminiLiveClient: reusable, dependency-free browser client for the Gemini Live
// API (native speech-to-speech) over a raw WebSocket, authenticated with a
// short-lived ephemeral token.
//
// This file contains ONLY voice transport. It knows nothing about shopping.
// Shopping features plug in later through `tokenProvider` (server decides the
// model/instructions/tools) and the optional `onToolCall` hook.
//
// Protocol details follow Google's docs:
//   https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
//   https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
//
// States: idle | requesting-mic | fetching-token | connecting | listening |
//         speaking | reconnecting | expired | error | closed

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const INPUT_MIME = "audio/pcm;rate=16000";
const DEFAULT_OUTPUT_RATE = 24000;
const MAX_RECONNECTS = 3;
const SETUP_TIMEOUT_MS = 10000;

function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class GeminiLiveClient {
  /**
   * @param {object} opts
   * @param {() => Promise<{token:string, setup:object, expireTime:string}>} opts.tokenProvider
   *        Fetches a fresh ephemeral token from YOUR backend.
   * @param {(state:string, detail?:object) => void} [opts.onState]
   * @param {(t:{role:'user'|'model', text:string, final:boolean}) => void} [opts.onTranscript]
   * @param {(e:{code:string, message:string}) => void} [opts.onError]
   * @param {(toolCall:object) => Promise<object[]>} [opts.onToolCall]
   *        Future hook: return functionResponses for a toolCall. Not used until tools are declared server-side.
   */
  constructor(opts) {
    this.tokenProvider = opts.tokenProvider;
    this.wsBase = opts.wsBase || WS_BASE; // override only for automated tests
    this.onState = opts.onState || (() => {});
    this.onTranscript = opts.onTranscript || (() => {});
    this.onError = opts.onError || (() => {});
    this.onToolCall = opts.onToolCall || null;

    this.state = "idle";
    this.ws = null;
    this.micStream = null;
    this.captureCtx = null;
    this.captureNode = null;
    this.playCtx = null;
    this.playSources = new Set();
    this.nextPlayTime = 0;
    this.current = null; // {token, setup, expireTime}
    this.resumeHandle = null;
    this.reconnects = 0;
    this.expiryTimer = null;
    this.setupTimer = null;
    this.setupDone = false;
    this.userStopped = false;
    this.pending = { user: "", model: "" };
    this._onVisibility = () => this._resumeAudio();
  }

  _setState(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state, detail);
  }

  _fail(code, message) {
    this.onError({ code, message });
    this._teardown();
    this._setState("error", { code });
  }

  // Must be called from a user gesture (tap) so mobile browsers allow audio + mic.
  async start() {
    if (this.state !== "idle" && this.state !== "closed" && this.state !== "error" && this.state !== "expired") return;
    this.userStopped = false;
    this.reconnects = 0;
    this.resumeHandle = null;

    try {
      this._setState("requesting-mic");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return this._fail("mic_unsupported", "This browser cannot access the microphone (HTTPS is required).");
      }
      // Create the playback context inside the tap so it is allowed to play.
      this.playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: DEFAULT_OUTPUT_RATE });
      await this.playCtx.resume();

      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
        return this._fail(
          denied ? "mic_denied" : "mic_error",
          denied ? "Microphone permission was denied. Allow it in the browser's site settings and try again." : "Could not open the microphone."
        );
      }

      await this._setupCapture();
      document.addEventListener("visibilitychange", this._onVisibility);

      this._setState("fetching-token");
      this.current = await this._getToken();
      await this._connect(false);
    } catch (err) {
      if (this.state !== "error") this._fail(err.code || "start_failed", err.message || "Could not start voice session.");
    }
  }

  async _getToken() {
    try {
      const t = await this.tokenProvider();
      if (!t || typeof t.token !== "string" || !t.setup) throw new Error("bad token response");
      return t;
    } catch (err) {
      const e = new Error(err && err.message ? err.message : "Could not get a voice token.");
      e.code = (err && err.code) || "token_failed";
      throw e;
    }
  }

  async _setupCapture() {
    // Capture context runs at the device's native rate; the worklet downsamples to 16 kHz.
    this.captureCtx = new (window.AudioContext || window.webkitAudioContext)();
    await this.captureCtx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
    const source = this.captureCtx.createMediaStreamSource(this.micStream);
    this.captureNode = new AudioWorkletNode(this.captureCtx, "capture-processor", { numberOfInputs: 1, numberOfOutputs: 0 });
    this.captureNode.port.onmessage = (ev) => this._onMicChunk(ev.data);
    source.connect(this.captureNode);
    // If the mic is taken away (e.g. another app), report it.
    for (const track of this.micStream.getAudioTracks()) {
      track.onended = () => {
        if (!this.userStopped) this._fail("mic_lost", "The microphone stopped working.");
      };
    }
  }

  _onMicChunk(buffer) {
    // Only stream after the server confirmed setup, and only while connected.
    if (!this.setupDone || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = { realtimeInput: { audio: { data: bytesToBase64(new Uint8Array(buffer)), mimeType: INPUT_MIME } } };
    this.ws.send(JSON.stringify(msg));
  }

  _connect(isReconnect) {
    return new Promise((resolve) => {
      this._setState(isReconnect ? "reconnecting" : "connecting");
      this.setupDone = false;
      const url = `${this.wsBase}?access_token=${encodeURIComponent(this.current.token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      this.setupTimer = setTimeout(() => {
        if (!this.setupDone && this.ws === ws) {
          try {
            ws.close();
          } catch (_) {}
          this._onSocketGone({ code: 4000, reason: "setup timeout" }, settle);
        }
      }, SETUP_TIMEOUT_MS);

      ws.onopen = () => {
        const setup = { ...this.current.setup };
        if (isReconnect && this.resumeHandle) {
          setup.sessionResumption = { handle: this.resumeHandle };
        }
        ws.send(JSON.stringify({ setup }));
      };

      ws.onmessage = async (ev) => {
        let text = ev.data;
        if (text instanceof Blob) text = await text.text(); // server frames may arrive as Blob
        let msg;
        try {
          msg = JSON.parse(text);
        } catch (_) {
          return;
        }
        this._onServerMessage(msg, settle);
      };

      ws.onerror = () => {
        /* details arrive via onclose; the browser gives none here */
      };

      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        this._onSocketGone({ code: ev.code, reason: ev.reason }, settle);
      };
    });
  }

  _onServerMessage(msg, settle) {
    if (msg.setupComplete !== undefined) {
      this.setupDone = true;
      clearTimeout(this.setupTimer);
      this.reconnects = 0;
      this._armExpiryTimer();
      this._setState("listening");
      settle();
      return;
    }

    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) this.resumeHandle = u.newHandle;
    }

    if (msg.goAway) {
      // Server will close soon: reconnect proactively with the resumption handle.
      this._reconnect("goAway");
      return;
    }

    if (msg.toolCall && this.onToolCall) {
      this._handleToolCall(msg.toolCall);
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      // User started talking over the model: drop everything queued for playback.
      this._flushPlayback();
      this._flushTranscripts();
    }

    if (sc.modelTurn && sc.modelTurn.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData && part.inlineData.data) {
          const mime = part.inlineData.mimeType || "";
          const m = /rate=(\d+)/.exec(mime);
          this._playPcm(base64ToBytes(part.inlineData.data), m ? Number(m[1]) : DEFAULT_OUTPUT_RATE);
        }
      }
    }

    if (sc.inputTranscription && sc.inputTranscription.text) {
      this.pending.user += sc.inputTranscription.text;
      this.onTranscript({ role: "user", text: this.pending.user, final: false });
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      this.pending.model += sc.outputTranscription.text;
      this.onTranscript({ role: "model", text: this.pending.model, final: false });
    }

    if (sc.turnComplete) {
      this._flushTranscripts();
    }
  }

  _flushTranscripts() {
    if (this.pending.user) this.onTranscript({ role: "user", text: this.pending.user, final: true });
    if (this.pending.model) this.onTranscript({ role: "model", text: this.pending.model, final: true });
    this.pending = { user: "", model: "" };
  }

  async _handleToolCall(toolCall) {
    try {
      const functionResponses = await this.onToolCall(toolCall);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
      }
    } catch (err) {
      this.onError({ code: "tool_failed", message: "A tool call failed." });
    }
  }

  // ---- playback -----------------------------------------------------------

  _playPcm(bytes, rate) {
    if (!this.playCtx) return;
    const samples = bytes.length >> 1;
    if (samples === 0) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
    const buf = this.playCtx.createBuffer(1, samples, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000; // little-endian
    const src = this.playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.playCtx.destination);
    const startAt = Math.max(this.playCtx.currentTime + 0.02, this.nextPlayTime);
    src.start(startAt);
    this.nextPlayTime = startAt + buf.duration;
    this.playSources.add(src);
    this._setState("speaking");
    src.onended = () => {
      this.playSources.delete(src);
      if (this.playSources.size === 0 && this.state === "speaking") this._setState("listening");
    };
  }

  _flushPlayback() {
    for (const src of this.playSources) {
      try {
        src.onended = null;
        src.stop();
      } catch (_) {}
    }
    this.playSources.clear();
    this.nextPlayTime = 0;
    if (this.state === "speaking") this._setState("listening");
  }

  _resumeAudio() {
    if (document.visibilityState !== "visible") return;
    for (const ctx of [this.playCtx, this.captureCtx]) {
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  _armExpiryTimer() {
    clearTimeout(this.expiryTimer);
    if (!this.current || !this.current.expireTime) return;
    const ms = new Date(this.current.expireTime).getTime() - Date.now();
    // Warn-free, clean stop a few seconds before Google cuts the token.
    this.expiryTimer = setTimeout(() => this._expire(), Math.max(1000, ms - 5000));
  }

  _expire() {
    this._teardown();
    this._setState("expired");
  }

  async _reconnect(reason) {
    if (this.userStopped || this.state === "reconnecting") return;
    this.reconnects += 1;
    if (this.reconnects > MAX_RECONNECTS) {
      return this._fail("reconnect_failed", "Connection lost and could not be restored.");
    }
    this._setState("reconnecting", { reason });
    this._closeSocketOnly();
    await new Promise((r) => setTimeout(r, 400 * this.reconnects));
    if (this.userStopped) return;
    try {
      // First try resuming with the same token + resumption handle; if the token
      // can no longer start a session, get a fresh one and start a new session.
      const tokenStillValid = this.current && new Date(this.current.expireTime).getTime() - Date.now() > 15000;
      if (!tokenStillValid || !this.resumeHandle) {
        this.current = await this._getToken();
        this.resumeHandle = null;
      }
      await this._connect(true);
    } catch (err) {
      this._fail(err.code || "reconnect_failed", err.message || "Could not reconnect.");
    }
  }

  _onSocketGone(info, settle) {
    clearTimeout(this.setupTimer);
    const wasReady = this.setupDone;
    this.setupDone = false;
    this.ws = null;
    if (this.userStopped || this.state === "expired" || this.state === "closed") {
      settle();
      return;
    }
    if (!wasReady && this.state !== "reconnecting") {
      // Failed during initial connect/setup.
      this.onError({ code: "connect_failed", message: `Could not start the voice session (code ${info.code}${info.reason ? ": " + info.reason : ""}).` });
      this._teardown();
      this._setState("error", { code: "connect_failed" });
      settle();
      return;
    }
    settle();
    this._reconnect("socket closed " + info.code);
  }

  _closeSocketOnly() {
    clearTimeout(this.setupTimer);
    const ws = this.ws;
    this.ws = null;
    this.setupDone = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(1000);
      } catch (_) {}
    }
  }

  _teardown() {
    clearTimeout(this.expiryTimer);
    clearTimeout(this.setupTimer);
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._closeSocketOnly();
    this._flushPlayback();
    if (this.captureNode) {
      this.captureNode.port.onmessage = null;
      try {
        this.captureNode.disconnect();
      } catch (_) {}
      this.captureNode = null;
    }
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) {
        t.onended = null;
        t.stop();
      }
      this.micStream = null;
    }
    for (const key of ["captureCtx", "playCtx"]) {
      if (this[key]) {
        this[key].close().catch(() => {});
        this[key] = null;
      }
    }
    this.pending = { user: "", model: "" };
  }

  stop() {
    this.userStopped = true;
    this._teardown();
    this._setState("closed");
  }
}
