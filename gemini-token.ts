import { PROFILES, clientSetup, tokenConstraintsConfig } from "./voice-profile.ts";
import type { ProfileName } from "./voice-profile.ts";

// Creates a short-lived Gemini Live ephemeral token using Google's documented
// REST endpoint (POST /v1beta/auth_tokens). The permanent API key is sent only
// from this server to Google, in the x-goog-api-key header.

export const TOKEN_LIFETIME_MS = 20 * 60 * 1000; // time allowed to keep sending messages
export const NEW_SESSION_WINDOW_MS = 60 * 1000; // time allowed to START a session

export class TokenError extends Error {
  httpStatus: number;
  publicCode: string;
  constructor(publicCode: string, httpStatus: number, message: string) {
    super(message);
    this.publicCode = publicCode;
    this.httpStatus = httpStatus;
  }
}

export type LiveToken = {
  token: string;
  model: string;
  expireTime: string;
  newSessionExpireTime: string;
  setup: Record<string, unknown>;
};

export async function createLiveToken(opts: {
  apiKey: string;
  apiBase: string;
  profile: ProfileName;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<LiveToken> {
  const now = opts.nowMs ?? Date.now();
  const f = opts.fetchImpl ?? fetch;
  const model = PROFILES[opts.profile].model;
  const expireTime = new Date(now + TOKEN_LIFETIME_MS).toISOString();
  const newSessionExpireTime = new Date(now + NEW_SESSION_WINDOW_MS).toISOString();

  const body = {
    uses: 1, // token can start exactly one session
    expireTime,
    newSessionExpireTime,
    liveConnectConstraints: {
      model: `models/${model}`,
      config: tokenConstraintsConfig(),
    },
  };

  let res: Response;
  try {
    res = await f(`${opts.apiBase}/v1beta/auth_tokens`, {
      method: "POST",
      headers: { "x-goog-api-key": opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new TokenError(timedOut ? "upstream_timeout" : "upstream_unreachable", 502, "Could not reach Gemini API");
  }

  if (!res.ok) {
    // Map upstream failures to safe, generic client-facing codes.
    let upstreamStatus = "";
    try {
      const j = (await res.json()) as { error?: { status?: string } };
      upstreamStatus = j?.error?.status ?? "";
    } catch {
      /* ignore body parse errors */
    }
    if (res.status === 401 || res.status === 403) {
      throw new TokenError("upstream_auth", 502, `Gemini rejected the server credentials (${res.status} ${upstreamStatus})`);
    }
    if (res.status === 429) {
      throw new TokenError("upstream_quota", 503, `Gemini quota or rate limit hit (${upstreamStatus})`);
    }
    if (res.status === 400 || res.status === 404) {
      throw new TokenError("upstream_rejected_request", 502, `Gemini rejected the token request (${res.status} ${upstreamStatus})`);
    }
    throw new TokenError("upstream_error", 502, `Gemini error (${res.status} ${upstreamStatus})`);
  }

  const data = (await res.json()) as { name?: unknown };
  if (typeof data.name !== "string" || data.name.length < 8) {
    throw new TokenError("upstream_bad_response", 502, "Gemini response did not contain a token");
  }

  return {
    token: data.name,
    model: `models/${model}`,
    expireTime,
    newSessionExpireTime,
    setup: clientSetup(opts.profile),
  };
}
