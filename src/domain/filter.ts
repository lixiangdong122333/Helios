import { HeliosError } from "../errors.js";
import type {
  BaseQueryInput,
  ServiceSelector,
  TimeRange
} from "./types.js";

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const MAX_FILTER_LENGTH = 20_000;

export interface QueryPolicy {
  maxWindowMs: number;
  defaultLookbackMinutes: number;
}

export function quoteFilterLiteral(value: string): string {
  return JSON.stringify(value);
}

export function resolveProjects(requested: string[] | undefined, allowed: string[]): string[] {
  if (allowed.length === 0) {
    throw new HeliosError("INTERNAL_ERROR", "No Cloud Logging projects are configured or discoverable.");
  }

  const projects = requested === undefined || requested.length === 0 ? allowed : [...new Set(requested)];
  for (const projectId of projects) {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new HeliosError("INVALID_ARGUMENT", `Invalid Google Cloud project ID: ${projectId}`);
    }
    if (!allowed.includes(projectId)) {
      throw new HeliosError("PERMISSION_DENIED", `Project is not in the Helios allowlist: ${projectId}`);
    }
  }
  return projects;
}

export function resolveTimeRange(
  input: Pick<BaseQueryInput, "startTime" | "endTime" | "lookbackMinutes">,
  policy: QueryPolicy,
  now = new Date()
): TimeRange {
  if (input.startTime !== undefined && input.lookbackMinutes !== undefined) {
    throw new HeliosError("INVALID_ARGUMENT", "Use either startTime or lookbackMinutes, not both.");
  }

  const end = input.endTime === undefined ? now : parseTimestamp(input.endTime, "endTime");
  const start =
    input.startTime === undefined
      ? new Date(end.getTime() - (input.lookbackMinutes ?? policy.defaultLookbackMinutes) * 60_000)
      : parseTimestamp(input.startTime, "startTime");

  if (start.getTime() >= end.getTime()) {
    throw new HeliosError("INVALID_ARGUMENT", "startTime must be earlier than endTime.");
  }
  if (end.getTime() - start.getTime() > policy.maxWindowMs) {
    throw new HeliosError(
      "INVALID_ARGUMENT",
      `The requested time range exceeds the configured maximum of ${policy.maxWindowMs / 3_600_000} hours.`
    );
  }

  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

function parseTimestamp(value: string, field: string): Date {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new HeliosError("INVALID_ARGUMENT", `${field} must be an RFC 3339 timestamp with a timezone.`);
  }
  return timestamp;
}

export function buildLoggingFilter(
  input: BaseQueryInput,
  projects: string[],
  timeRange: TimeRange
): string {
  const clauses = [
    `timestamp >= ${quoteFilterLiteral(timeRange.startTime)}`,
    `timestamp < ${quoteFilterLiteral(timeRange.endTime)}`
  ];

  if (input.traceId !== undefined) {
    clauses.push(buildTraceFilter(input.traceId, projects));
  }
  if (input.service !== undefined) {
    clauses.push(buildServiceFilter(input.service));
  }
  if (input.minSeverity !== undefined) {
    clauses.push(`severity >= ${input.minSeverity}`);
  }
  if (input.resourceTypes !== undefined && input.resourceTypes.length > 0) {
    for (const resourceType of input.resourceTypes) {
      if (!RESOURCE_TYPE_PATTERN.test(resourceType)) {
        throw new HeliosError("INVALID_ARGUMENT", `Invalid monitored resource type: ${resourceType}`);
      }
    }
    clauses.push(
      `(${input.resourceTypes.map(type => `resource.type = ${quoteFilterLiteral(type)}`).join(" OR ")})`
    );
  }
  if (input.searchText !== undefined) {
    const text = input.searchText.trim();
    if (text.length === 0 || text.length > 500) {
      throw new HeliosError("INVALID_ARGUMENT", "searchText must contain between 1 and 500 characters.");
    }
    clauses.push(`SEARCH(${quoteFilterLiteral(text)})`);
  }

  const filter = clauses.join("\nAND ");
  if (filter.length > MAX_FILTER_LENGTH) {
    throw new HeliosError("INVALID_ARGUMENT", "The compiled Cloud Logging filter is too long.");
  }
  return filter;
}

export function buildTraceFilter(traceId: string, projects: string[]): string {
  const canonicalMatch = /^projects\/([^/]+)\/traces\/([^/]+)$/i.exec(traceId);
  let traces: string[];

  if (canonicalMatch !== null) {
    const projectId = canonicalMatch[1];
    const rawTraceId = canonicalMatch[2];
    if (projectId === undefined || rawTraceId === undefined || !TRACE_ID_PATTERN.test(rawTraceId)) {
      throw new HeliosError("INVALID_ARGUMENT", "traceId must contain a 32-character hexadecimal trace ID.");
    }
    if (!projects.includes(projectId)) {
      throw new HeliosError("PERMISSION_DENIED", `Trace project is not part of this query: ${projectId}`);
    }
    traces = [`projects/${projectId}/traces/${rawTraceId.toLowerCase()}`];
  } else {
    if (!TRACE_ID_PATTERN.test(traceId)) {
      throw new HeliosError(
        "INVALID_ARGUMENT",
        "traceId must be 32 hexadecimal characters or projects/PROJECT_ID/traces/TRACE_ID."
      );
    }
    traces = [
      traceId.toLowerCase(),
      ...projects.map(projectId => `projects/${projectId}/traces/${traceId.toLowerCase()}`)
    ];
  }

  return `(${traces.map(trace => `trace = ${quoteFilterLiteral(trace)}`).join(" OR ")})`;
}

export function canonicalTraceProject(traceId: string | undefined): string | undefined {
  if (traceId === undefined) return undefined;
  return /^projects\/([^/]+)\/traces\/[0-9a-f]{32}$/i.exec(traceId)?.[1];
}

export function buildServiceFilter(selector: ServiceSelector): string {
  const name = selector.name.trim();
  if (name.length === 0 || name.length > 128) {
    throw new HeliosError("INVALID_ARGUMENT", "service.name must contain between 1 and 128 characters.");
  }

  const quotedName = quoteFilterLiteral(name);
  const platform = selector.platform ?? "auto";
  let core: string;

  switch (platform) {
    case "cloud_run":
      core = `(resource.type = "cloud_run_revision" AND resource.labels.service_name = ${quotedName})`;
      break;
    case "gke":
      core = buildGkeServiceFilter(quotedName);
      break;
    case "app_engine":
      core = `(resource.type = "gae_app" AND resource.labels.module_id = ${quotedName})`;
      break;
    case "generic":
      core = buildGenericServiceFilter(quotedName);
      break;
    case "auto":
      core = `(${[
        `(resource.type = "cloud_run_revision" AND resource.labels.service_name = ${quotedName})`,
        buildGkeServiceFilter(quotedName),
        `(resource.type = "gae_app" AND resource.labels.module_id = ${quotedName})`,
        buildGenericServiceFilter(quotedName)
      ].join(" OR ")})`;
      break;
    default:
      throw new HeliosError("INVALID_ARGUMENT", `Unsupported service platform: ${String(platform)}`);
  }

  const qualifiers: string[] = [];
  if (selector.namespace !== undefined) {
    qualifiers.push(`resource.labels.namespace_name = ${quoteFilterLiteral(selector.namespace)}`);
  }
  if (selector.cluster !== undefined) {
    qualifiers.push(`resource.labels.cluster_name = ${quoteFilterLiteral(selector.cluster)}`);
  }
  if (selector.location !== undefined) {
    qualifiers.push(`resource.labels.location = ${quoteFilterLiteral(selector.location)}`);
  }
  return qualifiers.length === 0 ? core : `(${core} AND ${qualifiers.join(" AND ")})`;
}

function buildGkeServiceFilter(quotedName: string): string {
  return `((resource.type = "k8s_service" AND resource.labels.service_name = ${quotedName}) OR ` +
    `((resource.type = "k8s_container" OR resource.type = "k8s_pod") AND (` +
    `resource.labels.container_name = ${quotedName} OR ` +
    `labels."k8s-pod/app" = ${quotedName} OR ` +
    `labels."k8s-pod/app_kubernetes_io/name" = ${quotedName})))`;
}

function buildGenericServiceFilter(quotedName: string): string {
  return `(` +
    `labels.service = ${quotedName} OR ` +
    `labels.service_name = ${quotedName} OR ` +
    `jsonPayload.service = ${quotedName} OR ` +
    `jsonPayload.serviceName = ${quotedName} OR ` +
    `jsonPayload.serviceContext.service = ${quotedName}` +
    `)`;
}
