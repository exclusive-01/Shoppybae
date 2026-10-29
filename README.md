# Shoppybae Voice

Reusable Gemini Live voice layer: a small secure backend that hands out short-lived
Gemini tokens, plus a browser client that streams your microphone straight to Gemini
Live (native speech-to-speech) and plays the reply in real time.

**This is voice infrastructure only.** There is no product search, catalog, or shopping
logic yet, and the assistant is told not to invent any.

## How it works

```
Phone browser ──(1) access code──────────▶ your server  /api/session
              ◀─ login session (1 hour) ──
              ──(2) login session ────────▶ your server  /api/live-token ──▶ Google (permanent key stays here)
              ◀─ short-lived Gemini token ─
              ──(3) mic audio + token ────▶ Gemini Live WebSocket  (direct, no proxy in between)
              ◀─ spoken reply ─────────────
```

* Model: `gemini-3.8-live` (Stable on Google's official models page, last updated 2026-10-22).
  `gemini-3.8-live-extended-thinking` is available as the `extended-thinking` profile.
* Token: single use, ~1 minute to start a session, ~20 minutes of lifetime. The model,
  audio mode and assistant instructions are locked into the token on the server.
* Your permanent `GEMINI_API_KEY` is only ever read from an environment variable on the
  server and is only sent from the server to Google.

## Files

| Path | What it is |
| --- | --- |
| `src/` | Backend (Node 22, TypeScript syntax run directly, **no npm packages needed**) |
| `src/voice-profile.ts` | **The one place** for model IDs, assistant instructions, session settings |
| `src/auth.ts` | Login. Replace `authenticate()` with Shoppybae's real login later |
| `src/gemini-token.ts` | Creates the ephemeral token (Google REST `auth_tokens`) |
| `public/voice/gemini-live-client.js` | **Reusable voice client** (no dependencies, no shopping code) |
| `public/voice/capture-worklet.js` | Microphone → 16 kHz 16-bit PCM |
| `public/index.html`, `app.js` | A small page to try the voice connection |
| `test/`, `tools/browser-test.mjs` | Automated tests |
| `render.yaml` | Deployment settings for Render |

## Deploy from a phone (Render)

1. **Google AI Studio** → `aistudio.google.com/apikey` → create an API key. Keep it in your
   notes app. Do not paste it into chat or into any file in this project.
   Live API may need billing enabled on that key's project.
2. Put this project in a **GitHub** repository (see "Getting the files onto GitHub" below).
3. **Render** (`render.com`) → sign in with GitHub → **New +** → **Blueprint** → pick the repo → continue.
4. Render shows two empty fields. This is the secure place for secrets:
   * `GEMINI_API_KEY` → paste your key here.
   * `ACCESS_CODE` → type a passcode you will remember (8+ characters). You type it on the voice page.
   * `SESSION_SECRET` is created automatically. Leave `ALLOWED_ORIGINS` empty for now.
5. Click **Apply / Deploy**. When it says **Live**, open the `https://….onrender.com` address.
6. Unlock with your access code → **Start talking** → allow the microphone → speak.

To change a secret later: Render → your service → **Environment** → edit → Save (it redeploys).

Free Render services sleep after inactivity; the first load can take about a minute.

## Getting the files onto GitHub from a phone

GitHub's mobile website cannot upload folders in one go. Easiest options:
* Use a laptop/desktop once (drag the unzipped folder into a new repo's "Upload files" page), or
* On the phone: create a new repo, then for each file use **Add file → Create new file**, type the
  path (e.g. `src/app.ts`) as the name, and paste its contents. Files with no folder can be uploaded directly.

## Connecting to Shoppybae later

1. **Login:** edit `authenticate()` in `src/auth.ts` to accept your website's real login and return
   that user's id. Rate limits are already per user.
2. **Website origin:** put your site's address in `ALLOWED_ORIGINS` (e.g. `https://www.shoppybae.com`).
3. **Frontend:** copy `public/voice/` into your site and use it like this:

```js
import { GeminiLiveClient } from "/voice/gemini-live-client.js";
const client = new GeminiLiveClient({
  tokenProvider: () => fetch("https://YOUR-VOICE-SERVER/api/live-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + yourSessionToken },
    body: JSON.stringify({ profile: "default" }),
  }).then((r) => r.json()),
  onState: (s) => {}, onTranscript: (t) => {}, onError: (e) => {},
});
button.onclick = () => client.start(); // must run from a tap
```
4. **Shopping behaviour (later):** change `SYSTEM_INSTRUCTION` and add tools in `src/voice-profile.ts`
   (tools must be added in both `tokenConstraintsConfig()` and `clientSetup()`), and handle them with
   the client's `onToolCall` hook backed by your real product search. The hook exists but has **not been
   exercised**, and no tools are declared today.

## Security summary

* Key only in a server environment variable; the server refuses to start without required secrets.
* Token endpoint needs a signed login session, is rate limited per IP and per user, and only accepts known profiles.
* Responses are `no-store`; CORS blocks unlisted websites; strict Content-Security-Policy.
* Logs never contain keys, tokens, passcodes or request bodies (tested).
* The ephemeral token is visible to the user's browser by design; it is single-use and short-lived.

## Tests

```
npm test                    # 14 backend tests, no installs needed
node tools/browser-test.mjs # 21 browser checks against a LOCAL FAKE Gemini server (needs Playwright + Chromium)
```
