import { loadConfig } from "./config.ts";
import { createLogger, registerSecret } from "./logger.ts";
import { createApp } from "./app.ts";

let config;
try {
  config = loadConfig();
} catch (err) {
  // Prints variable NAMES that are wrong, never values.
  console.error(err instanceof Error ? err.message : "Invalid configuration");
  process.exit(1);
}

registerSecret(config.geminiApiKey);
registerSecret(config.accessCode);
registerSecret(config.sessionSecret);

const log = createLogger(config.logLevel);
const { server, stop } = createApp(config, log);

server.listen(config.port, "0.0.0.0", () => {
  log.info("shoppybae-voice listening", { port: config.port });
});

const shutdown = (signal: string) => {
  log.info("shutting down", { signal });
  stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
