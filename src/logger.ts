import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function createLogger(minimumLevel: LogLevel = "info"): Logger {
  const minimumRank = levelRank[minimumLevel];

  const write = (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    if (levelRank[level] < minimumRank) {
      return;
    }

    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...fields
      })}\n`
    );
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

export function auditHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
