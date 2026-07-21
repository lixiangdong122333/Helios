import { createHash } from "node:crypto";
import type { JsonValue, NormalizedLogEntry } from "./types.js";
import { isJsonObject } from "./normalize.js";

export interface ExceptionSample {
  timestamp: string | null;
  service?: string;
  trace?: string;
  insertId?: string;
  message: string;
}

export interface ExceptionGroup {
  fingerprint: string;
  exceptionType: string;
  normalizedMessage: string;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  services: string[];
  severities: string[];
  traces: string[];
  samples: ExceptionSample[];
}

export interface ExceptionAggregationResult {
  processedEntries: number;
  matchedExceptions: number;
  groupCount: number;
  groups: ExceptionGroup[];
}

export function aggregateExceptions(
  entries: NormalizedLogEntry[],
  groupLimit: number,
  samplesPerGroup: number
): ExceptionAggregationResult {
  const groups = new Map<string, MutableExceptionGroup>();
  let matchedExceptions = 0;

  for (const entry of entries) {
    const details = getExceptionDetails(entry);
    if (details === undefined) {
      continue;
    }
    matchedExceptions += 1;
    const normalizedMessage = normalizeExceptionText(details.message);
    const normalizedStack = normalizeStack(details.stack);
    const exceptionType = details.exceptionType ?? inferExceptionType(details.message, details.stack);
    const fingerprint = entry.errorGroupIds?.[0] === undefined
      ? createHash("sha256")
        .update(`${exceptionType}\n${normalizedMessage}\n${normalizedStack}`)
        .digest("hex")
        .slice(0, 20)
      : `error-group:${entry.errorGroupIds[0]}`;
    let group = groups.get(fingerprint);
    if (group === undefined) {
      group = {
        fingerprint,
        exceptionType,
        normalizedMessage,
        count: 0,
        firstSeen: entry.timestamp,
        lastSeen: entry.timestamp,
        services: new Set<string>(),
        severities: new Set<string>(),
        traces: new Set<string>(),
        samples: []
      };
      groups.set(fingerprint, group);
    }

    group.count += 1;
    group.firstSeen = earlier(group.firstSeen, entry.timestamp);
    group.lastSeen = later(group.lastSeen, entry.timestamp);
    if (entry.service !== undefined) group.services.add(entry.service);
    group.severities.add(entry.severity);
    if (entry.trace !== undefined) group.traces.add(entry.trace);
    if (group.samples.length < samplesPerGroup) {
      group.samples.push({
        timestamp: entry.timestamp,
        ...(entry.service === undefined ? {} : { service: entry.service }),
        ...(entry.trace === undefined ? {} : { trace: entry.trace }),
        ...(entry.insertId === undefined ? {} : { insertId: entry.insertId }),
        message: details.message.slice(0, 2_000)
      });
    }
  }

  const output = [...groups.values()]
    .sort((left, right) => right.count - left.count || left.fingerprint.localeCompare(right.fingerprint))
    .slice(0, groupLimit)
    .map(group => ({
      fingerprint: group.fingerprint,
      exceptionType: group.exceptionType,
      normalizedMessage: group.normalizedMessage,
      count: group.count,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      services: [...group.services].sort(),
      severities: [...group.severities].sort(),
      traces: [...group.traces].slice(0, 20).sort(),
      samples: group.samples
    }));

  return {
    processedEntries: entries.length,
    matchedExceptions,
    groupCount: groups.size,
    groups: output
  };
}

export function summarizeLogs(entries: NormalizedLogEntry[], topServices: number): Record<string, unknown> {
  const severities = countBy(entries.map(entry => entry.severity));
  const services = topCounts(entries.map(entry => entry.service ?? "(unknown)"), topServices);
  const resourceTypes = topCounts(entries.map(entry => entry.resource.type ?? "(unknown)"), 20);
  const timestamps = entries.map(entry => entry.timestamp).filter((value): value is string => value !== null).sort();
  return {
    processedEntries: entries.length,
    observedRange: {
      firstTimestamp: timestamps[0] ?? null,
      lastTimestamp: timestamps.at(-1) ?? null
    },
    bySeverity: severities,
    topServices: services,
    byResourceType: resourceTypes
  };
}

interface MutableExceptionGroup {
  fingerprint: string;
  exceptionType: string;
  normalizedMessage: string;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  services: Set<string>;
  severities: Set<string>;
  traces: Set<string>;
  samples: ExceptionSample[];
}

function getExceptionDetails(
  entry: NormalizedLogEntry
): { message: string; stack: string; exceptionType?: string } | undefined {
  const payload = entry.payload;
  const message = entry.message ?? findString(payload, ["message", "msg", "error.message"]);
  const structuredStack = entry.exception?.stack ?? findString(payload, [
    "stack",
    "stacktrace",
    "stackTrace",
    "exception.stack",
    "error.stack",
    "exception"
  ]);
  const stack = structuredStack ?? (message !== undefined && /\r?\n\s*at\s+/.test(message) ? message : undefined);
  const exceptionType = entry.exception?.type ?? findString(payload, ["exception.type", "error.type", "exceptionType"]);
  const errorSeverity = severityRank(entry.severity) >= severityRank("ERROR");
  if (message === undefined && stack === undefined) {
    return undefined;
  }
  if (stack === undefined && !errorSeverity && !/(?:error|exception|failure|fault)/i.test(message ?? "")) {
    return undefined;
  }
  return {
    message: message ?? firstLine(stack ?? "Unknown exception"),
    stack: stack ?? "",
    ...(exceptionType === undefined ? {} : { exceptionType })
  };
}

function findString(value: JsonValue | undefined, paths: string[]): string | undefined {
  for (const path of paths) {
    let current: JsonValue | undefined = value;
    for (const segment of path.split(".")) {
      if (!isJsonObject(current)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    if (typeof current === "string" && current.length > 0) {
      return current;
    }
  }
  return undefined;
}

function inferExceptionType(message: string, stack: string): string {
  const match = /\b([A-Za-z_$][\w.$]*(?:Error|Exception|Failure|Fault))\b/.exec(`${message}\n${stack}`);
  return match?.[1] ?? "UnknownError";
}

function normalizeExceptionText(value: string): string {
  return value
    .split(/\r?\n/, 1)[0]!
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b\d{5,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function normalizeStack(stack: string): string {
  return stack
    .split(/\r?\n/)
    .filter(line => /^\s*at\s+/.test(line) || /(?:Error|Exception|Failure|Fault)/.test(line))
    .slice(0, 4)
    .map(line => line.replace(/:\d+(?::\d+)?(?=[)\s]|$)/g, ":<line>").trim())
    .join("\n");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

function severityRank(severity: string): number {
  const order = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];
  return Math.max(0, order.indexOf(severity.toUpperCase()));
}

function earlier(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

function countBy(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

function topCounts(values: string[], limit: number): Array<{ value: string; count: number }> {
  return Object.entries(countBy(values))
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, limit);
}
