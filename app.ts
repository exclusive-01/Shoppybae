import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import { authenticate, checkAccessCode, signSession } from "./auth.ts";
import { createLimiter } from "./ratelimit.ts";
import { createLiveToken, TokenError } from "./gemini-token.ts";
import { isProfileName } from "./voice-profile.ts";
import type { ProfileName } from "./voice-profile.ts";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const SESSION_TTL_SEC = 60 * 60; // login session lasts 1 hour
const MAX_BODY_BYTES = 2048;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function createApp(config: Config, log: Logger, deps: { fetchImpl?: typeof fetch } = {}) {
  // Per-IP: protect the passcode from guessing. Per-principal/IP: protect token minting (and your quota).
  const loginLimiter = createLimiter({ windowMs: 15 * 60_000, max: 10 });
  const tokenIpLimiter = createLimiter({ windowMs: 60 * 60_000, max: 60 });
  const tokenUserLimiter = createLimiter({ windowMs: 60 * 60_000, max: 30 });

  const clientIp = (req: http.IncomingMessage): string => {
    if (config.trustProxyHops > 0) {
      const xff = String(req.headers["x-forwarded-for"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Only trust the entries appended by our own proxy hops (counted from the right).
      const idx = xff.length - config.trustProxyHops;
      if (idx >= 0 && xff[idx]) return xff[idx];
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const securityHeaders = (res: http.ServerResponse) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self' wss://generativelanguage.googleapis.com",
        "img-src 'self' data:",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; ")
    );
  };

  const sendJson = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(payload),
      ...extra,
    });
    res.end(payload);
  };

  const readJson = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const type = String(req.headers["content-type"] ?? "");
      if (!type.toLowerCase().startsWith("application/json")) return reject(new HttpError(415, "unsupported_media_type"));
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, "body_too_large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (size === 0) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (v === null || typeof v !== "object" || Array.isArray(v)) return reject(new HttpError(400, "invalid_json"));
          resolve(v as Record<string, unknown>);
        } catch {
          reject(new HttpError(400, "invalid_json"));
        }
      });
      req.on("error", () => reject(new HttpError(400, "read_error")));
    });

  // CORS: same-origin always allowed; other origins only if listed in ALLOWED_ORIGINS.
  const applyCors = (req: http.IncomingMessage, res: http.ServerResponse): "ok" | "blocked" => {
    const origin = req.headers.origin;
    if (!origin) return "ok";
    const host = req.headers.host;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === host;
    } catch {
      return "blocked";
    }
    const allowed = sameOrigin || config.allowedOrigins.includes(origin.replace(/\/+$/, ""));
    if (!allowed) return "blocked";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    return "ok";
  };

  const serveStatic = async (urlPath: string, res: http.ServerResponse): Promise<boolean> => {
    const rel = urlPath === "/" ? "/index.html" : urlPath;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return false;
    }
    const full = path.resolve(PUBLIC_DIR, "." + decoded);
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return false; // path traversal guard
    const type = MIME[path.extname(full)];
    if (!type) return false;
    try {
      const data = await readFile(full);
      res.writeHead(200, { "Content-Type": type, "Content-Length": data.length, "Cache-Control": "no-cache" });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  };

  const handleApi = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => {
    if (applyCors(req, res) === "blocked") {
      log.warn("blocked cross-origin request", { path: pathname });
      return sendJson(res, 403, { error: "origin_not_allowed" });
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });

    const ip = clientIp(req);

    // ---- POST /api/session: passcode -> short-lived session token ----------
    if (pathname === "/api/session") {
      const rl = loginLimiter.check(ip);
      if (!rl.ok) return sendJson(res, 429, { error: "too_many_attempts" }, { "Retry-After": String(rl.retryAfterSec) });
      const body = await readJson(req);
      const code = body.code;
      if (typeof code !== "string" || code.length < 1 || code.length > 200) return sendJson(res, 400, { error: "invalid_request" });
      if (!checkAccessCode(code, config.accessCode)) {
        log.warn("login failed");
        return sendJson(res, 401, { error: "invalid_code" });
      }
      const sessionToken = signSession(config.sessionSecret, "passcode-user", SESSION_TTL_SEC);
      log.info("login ok");
      return sendJson(res, 200, { sessionToken, expiresInSec: SESSION_TTL_SEC });
    }

    // ---- POST /api/live-token: session token -> Gemini ephemeral token -----
    if (pathname === "/api/live-token") {
      const principal = authenticate(req.headers.authorization, config.sessionSecret);
      if (!principal) return sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });

      const ipRl = tokenIpLimiter.check(ip);
      const userRl = tokenUserLimiter.check(principal.id);
      if (!ipRl.ok || !userRl.ok) {
        const retry = Math.max(ipRl.retryAfterSec, userRl.retryAfterSec);
        log.warn("token rate limit hit");
        return sendJson(res, 429, { error: "rate_limited" }, { "Retry-After": String(retry) });
      }

      const body = await readJson(req);
      const requested = body.profile ?? "default";
      if (!isProfileName(requested)) return sendJson(res, 400, { error: "invalid_profile" });
      const profile: ProfileName = requested;

      try {
        const t = await createLiveToken({
          apiKey: config.geminiApiKey,
          apiBase: config.geminiApiBase,
          profile,
          fetchImpl: deps.fetchImpl,
        });
        log.info("ephemeral token issued", { profile, model: t.model });
        return sendJson(res, 200, t);
      } catch (err) {
        if (err instanceof TokenError) {
          log.error("token creation failed", { reason: err.publicCode, detail: err.message });
          return sendJson(res, err.httpStatus, { error: err.publicCode });
        }
        throw err;
      }
    }

    return sendJson(res, 404, { error: "not_found" });
  };

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const started = Date.now();
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (pathname === "/healthz") return sendJson(res, 200, { ok: true });

      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname);
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" });
      if (await serveStatic(pathname, res)) return;
      return sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.code });
        return;
      }
      log.error("unhandled error", { error: err instanceof Error ? err.message : "unknown" });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    } finally {
      log.debug("request", { method: req.method, path: (req.url ?? "").split("?")[0], ms: Date.now() - started });
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  return {
    server,
    stop: () => {
      loginLimiter.stop();
      tokenIpLimiter.stop();
      tokenUserLimiter.stop();
    },
  };
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
