import type { JsonValue, NormalizedLogEntry, RawLogEntry } from "./types.js";

export interface NormalizationPolicy {
  redactedKeys: Set<string>;
  maxStringLength: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxDepth: number;
}

export const defaultRedactedKeys = new Set([
  "authorization",
  "cookie",
  "set_cookie",
  "password",
  "passwd",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "api_key",
  "apikey",
  "secret",
  "client_secret"
]);

export const defaultNormalizationPolicy: NormalizationPolicy = {
  redactedKeys: defaultRedactedKeys,
  maxStringLength: 16_384,
  maxArrayItems: 100,
  maxObjectKeys: 200,
  maxDepth: 12
};

export function normalizeLogEntry(
  entry: RawLogEntry,
  includePayload: boolean,
  policy: NormalizationPolicy = defaultNormalizationPolicy
): NormalizedLogEntry {
  const metadata = entry.metadata;
  const resource = asRecord(metadata.resource);
  const resourceLabels = toStringRecord(asRecord(resource.labels), policy);
  const labels = toStringRecord(asRecord(metadata.labels), policy);
  const payload = toJsonValue(entry.data, policy);
  const result: NormalizedLogEntry = {
    timestamp: toIsoTimestamp(metadata.timestamp),
    receiveTimestamp: toIsoTimestamp(metadata.receiveTimestamp),
    severity: toOptionalString(metadata.severity) ?? "DEFAULT",
    resource: {
      ...(toOptionalString(resource.type) === undefined ? {} : { type: toOptionalString(resource.type) }),
      labels: resourceLabels
    },
    labels
  };

  assignOptionalString(result, "insertId", metadata.insertId);
  assignOptionalString(result, "logName", metadata.logName);
  assignOptionalString(result, "trace", metadata.trace);
  assignOptionalString(result, "spanId", metadata.spanId);
  if (typeof metadata.traceSampled === "boolean") {
    result.traceSampled = metadata.traceSampled;
  }
  const errorGroupIds = extractErrorGroupIds(metadata.errorGroups);
  if (errorGroupIds.length > 0) {
    result.errorGroupIds = errorGroupIds;
  }

  const service = extractService(resourceLabels, labels, payload);
  if (service !== undefined) {
    result.service = service;
  }
  const message = extractMessage(payload);
  if (message !== undefined) {
    result.message = truncate(message, policy.maxStringLength);
  }
  const exception = extractExceptionProjection(payload, policy.maxStringLength);
  if (exception !== undefined) {
    result.exception = exception;
  }
  const httpRequest = toJsonValue(metadata.httpRequest, policy);
  if (httpRequest !== undefined) {
    result.httpRequest = httpRequest;
  }
  const sourceLocation = toJsonValue(metadata.sourceLocation, policy);
  if (sourceLocation !== undefined) {
    result.sourceLocation = sourceLocation;
  }
  if (includePayload && payload !== undefined) {
    result.payload = payload;
  }
  return result;
}

export function toJsonValue(
  value: unknown,
  policy: NormalizationPolicy = defaultNormalizationPolicy,
  depth = 0,
  seen = new WeakSet<object>()
): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncate(value, policy.maxStringLength);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `[binary:${value.byteLength} bytes]`;
  }
  if (typeof value !== "object") {
    return truncate(String(value), policy.maxStringLength);
  }
  if (depth >= policy.maxDepth) {
    return "[maximum depth reached]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  let result: JsonValue;
  if (Array.isArray(value)) {
    result = value
      .slice(0, policy.maxArrayItems)
      .map(item => toJsonValue(item, policy, depth + 1, seen) ?? null);
  } else {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value).slice(0, policy.maxObjectKeys)) {
      if (shouldRedactKey(key, policy.redactedKeys)) {
        output[key] = "[REDACTED]";
        continue;
      }
      const converted = toJsonValue(child, policy, depth + 1, seen);
      if (converted !== undefined) {
        output[key] = converted;
      }
    }
    result = output;
  }

  seen.delete(value);
  return result;
}

export function extractMessage(payload: JsonValue | undefined): string | undefined {
  if (typeof payload === "string") {
    return payload;
  }
  if (!isJsonObject(payload)) {
    return undefined;
  }
  for (const key of ["message", "msg", "textPayload", "summary"]) {
    const value = payload[key];
    if (typeof value === "string") {
      return value;
    }
  }
  const error = payload.error;
  if (isJsonObject(error) && typeof error.message === "string") {
    return error.message;
  }
  return undefined;
}

export function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractService(
  resourceLabels: Record<string, string>,
  labels: Record<string, string>,
  payload: JsonValue | undefined
): string | undefined {
  for (const key of ["service_name", "module_id", "container_name", "job_name"]) {
    if (resourceLabels[key] !== undefined) {
      return resourceLabels[key];
    }
  }
  for (const key of ["service", "service_name", "k8s-pod/app", "k8s-pod/app_kubernetes_io/name"]) {
    if (labels[key] !== undefined) {
      return labels[key];
    }
  }
  if (isJsonObject(payload)) {
    for (const key of ["service", "serviceName"]) {
      const value = payload[key];
      if (typeof value === "string") {
        return value;
      }
    }
    const serviceContext = payload.serviceContext;
    if (isJsonObject(serviceContext) && typeof serviceContext.service === "string") {
      return serviceContext.service;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toStringRecord(
  value: Record<string, unknown>,
  policy: NormalizationPolicy
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value).slice(0, policy.maxObjectKeys)) {
    if (item !== undefined && item !== null) {
      output[key] = shouldRedactKey(key, policy.redactedKeys)
        ? "[REDACTED]"
        : truncate(String(item), policy.maxStringLength);
    }
  }
  return output;
}

function extractErrorGroupIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(item => asRecord(item).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, 20);
}

function extractExceptionProjection(
  payload: JsonValue | undefined,
  maximumLength: number
): { type?: string; stack?: string } | undefined {
  const type = findNestedString(payload, ["exception.type", "error.type", "exceptionType"]);
  const stack = findNestedString(payload, [
    "stack",
    "stacktrace",
    "stackTrace",
    "exception.stack",
    "error.stack",
    "exception"
  ]);
  if (type === undefined && stack === undefined) {
    return undefined;
  }
  return {
    ...(type === undefined ? {} : { type: truncate(type, 256) }),
    ...(stack === undefined ? {} : { stack: truncate(stack, maximumLength) })
  };
}

function findNestedString(value: JsonValue | undefined, paths: string[]): string | undefined {
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

function toOptionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function assignOptionalString<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  const converted = toOptionalString(value);
  if (converted !== undefined) {
    target[key] = converted as T[K];
  }
}

function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
  }
  if (value !== null && typeof value === "object") {
    const candidate = value as { seconds?: number | string; nanos?: number };
    if (candidate.seconds !== undefined) {
      const milliseconds = Number(candidate.seconds) * 1000 + (candidate.nanos ?? 0) / 1_000_000;
      const timestamp = new Date(milliseconds);
      return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
    }
  }
  return null;
}

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
}

function shouldRedactKey(key: string, redactedKeys: Set<string>): boolean {
  const normalized = normalizeKey(key);
  for (const sensitiveKey of redactedKeys) {
    if (normalized === sensitiveKey || normalized.endsWith(`_${sensitiveKey}`)) {
      return true;
    }
  }
  return false;
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength)}...[truncated ${value.length - maximumLength} chars]`;
}
