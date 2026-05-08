/**
 * Stderr-only structured JSON-line logger.
 *
 * stdout is reserved for MCP JSON-RPC framing — one stray console.log
 * corrupts the protocol. Always log via this module; never console.log.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const minLevel: LogLevel = (process.env.MSU_LOG_LEVEL as LogLevel) || "info";
const minLevelValue = LEVELS[minLevel] ?? LEVELS.info;

export function log(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVELS[level] < minLevelValue) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  try {
    process.stderr.write(JSON.stringify(record) + "\n");
  } catch {
    // never let logging crash the server
  }
}
