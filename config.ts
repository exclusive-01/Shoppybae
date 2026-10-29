// Central, validated configuration. Secrets come ONLY from environment variables.
// Error messages name the missing variable, never its value.

export type Config = {
  geminiApiKey: string;
  accessCode: string;
  sessionSecret: string;
  allowedOrigins: string[];
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  trustProxyHops: number;
  // Test-only override so the token flow can be exercised against a local fake.
  // Defaults to Google's real endpoint.
  geminiApiBase: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const problems: string[] = [];

  const need = (name: string, minLen: number): string => {
    const v = (env[name] ?? "").trim();
    if (!v) problems.push(`${name} is missing`);
    else if (v.length < minLen) problems.push(`${name} is too short (min ${minLen} characters)`);
    return v;
  };

  const geminiApiKey = need("GEMINI_API_KEY", 10);
  const accessCode = need("ACCESS_CODE", 8);
  const sessionSecret = need("SESSION_SECRET", 32);

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  for (const o of allowedOrigins) {
    try {
      const u = new URL(o);
      if (u.protocol !== "https:" && u.hostname !== "localhost") {
        problems.push(`ALLOWED_ORIGINS entry must be https: ${u.origin}`);
      }
    } catch {
      problems.push("ALLOWED_ORIGINS contains an invalid URL");
    }
  }

  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("PORT is invalid");

  const lvl = (env.LOG_LEVEL ?? "info").toLowerCase();
  const logLevel = (["debug", "info", "warn", "error"].includes(lvl) ? lvl : "info") as Config["logLevel"];

  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    problems.push("TRUST_PROXY_HOPS must be an integer 0-5");
  }

  const geminiApiBase = (env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");

  if (problems.length) {
    throw new Error("Invalid configuration: " + problems.join("; "));
  }

  return { geminiApiKey, accessCode, sessionSecret, allowedOrigins, port, logLevel, trustProxyHops, geminiApiBase };
}
