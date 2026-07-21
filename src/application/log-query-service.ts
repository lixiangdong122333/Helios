import { aggregateExceptions, summarizeLogs } from "../domain/aggregate.js";
import { buildLoggingFilter, canonicalTraceProject, resolveProjects, resolveTimeRange } from "../domain/filter.js";
import {
  defaultNormalizationPolicy,
  defaultRedactedKeys,
  normalizeLogEntry,
  type NormalizationPolicy
} from "../domain/normalize.js";
import type {
  AggregateExceptionsInput,
  BaseQueryInput,
  GetTraceLogsInput,
  LogRepository,
  NormalizedLogEntry,
  QueryLogsInput,
  QueryLogsResult,
  QueryMetadata,
  ScanLogsInput,
  SummarizeLogsInput,
  TimeRange
} from "../domain/types.js";
import { HeliosError } from "../errors.js";
import type { LoggingConfig } from "../config.js";

interface PreparedQuery {
  projects: string[];
  timeRange: TimeRange;
  filter: string;
}

interface ScanResult extends PreparedQuery {
  entries: NormalizedLogEntry[];
  partial: boolean;
  deadlineExceeded: boolean;
  nextPageToken?: string;
}

export class LogQueryService {
  private allowedProjectsPromise: Promise<string[]> | undefined;
  private readonly normalizationPolicy: NormalizationPolicy;

  constructor(
    private readonly repository: LogRepository,
    private readonly config: LoggingConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    this.normalizationPolicy = {
      ...defaultNormalizationPolicy,
      redactedKeys: new Set([...defaultRedactedKeys, ...config.redactedKeys.map(normalizeRedactionKey)])
    };
  }

  async queryLogs(input: QueryLogsInput): Promise<QueryLogsResult> {
    validatePaginationWindow(input);
    const prepared = await this.prepare(input);
    const limit = boundedInteger(input.limit ?? 100, 1, this.config.maxQueryEntries, "limit");
    const page = await this.repository.listEntries({
      projectIds: prepared.projects,
      filter: prepared.filter,
      order: input.order ?? "desc",
      pageSize: limit,
      ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
      timeoutMs: this.config.queryTimeoutMs
    });
    const entries = page.entries.map(entry =>
      this.enforceEntrySize(normalizeLogEntry(entry, input.includePayload ?? false, this.normalizationPolicy))
    );
    const metadata: QueryMetadata = {
      projects: prepared.projects,
      timeRange: prepared.timeRange,
      filter: prepared.filter,
      returnedEntries: entries.length,
      responseTruncated: false,
      droppedEntries: 0,
      ...(page.nextPageToken === undefined ? {} : { nextPageToken: page.nextPageToken })
    };
    return this.enforceResponseSize({ metadata, entries });
  }

  async getTraceLogs(input: GetTraceLogsInput): Promise<QueryLogsResult> {
    return this.queryLogs({ ...input, traceId: input.traceId, order: input.order ?? "asc" });
  }

  async summarize(input: SummarizeLogsInput): Promise<Record<string, unknown>> {
    const scan = await this.scan(input);
    const result = {
      metadata: this.scanMetadata(scan),
      summary: summarizeLogs(scan.entries, boundedInteger(input.topServices ?? 20, 1, 100, "topServices"))
    };
    this.assertResponseSize(result);
    return result;
  }

  async aggregateExceptions(input: AggregateExceptionsInput): Promise<Record<string, unknown>> {
    const minimumSeverity = stricterSeverity(input.minSeverity, "ERROR");
    const effectiveInput: AggregateExceptionsInput = input.includeNonErrorSeverity
      ? input
      : { ...input, minSeverity: minimumSeverity };
    const scan = await this.scan(effectiveInput);
    const aggregation = aggregateExceptions(
      scan.entries,
      boundedInteger(input.groupLimit ?? 50, 1, 200, "groupLimit"),
      boundedInteger(input.samplesPerGroup ?? 3, 0, 10, "samplesPerGroup")
    );
    const result: Record<string, unknown> = {
      metadata: this.scanMetadata(scan),
      aggregation
    };
    trimGroupsToSize(result, this.config.maxResponseBytes);
    this.assertResponseSize(result);
    return result;
  }

  private async scan(input: ScanLogsInput): Promise<ScanResult> {
    const prepared = await this.prepare(input);
    const scanLimit = boundedInteger(input.scanLimit ?? this.config.maxScanEntries, 1, this.config.maxScanEntries, "scanLimit");
    const entries: NormalizedLogEntry[] = [];
    const deadline = Date.now() + this.config.queryTimeoutMs;
    let pageToken: string | undefined;
    let deadlineExceeded = false;
    const seenTokens = new Set<string>();

    while (entries.length < scanLimit) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        deadlineExceeded = true;
        break;
      }
      const pageSize = Math.min(200, scanLimit - entries.length);
      try {
        const page = await this.repository.listEntries({
          projectIds: prepared.projects,
          filter: prepared.filter,
          order: "desc",
          pageSize,
          ...(pageToken === undefined ? {} : { pageToken }),
          timeoutMs: remainingMs
        });
        entries.push(
          ...page.entries.map(entry =>
            this.enforceEntrySize(normalizeLogEntry(entry, false, this.normalizationPolicy))
          )
        );
        pageToken = page.nextPageToken;
      } catch (error) {
        if (error instanceof HeliosError && error.code === "DEADLINE_EXCEEDED" && entries.length > 0) {
          deadlineExceeded = true;
          break;
        }
        throw error;
      }
      if (pageToken === undefined || pageToken === "") {
        break;
      }
      if (seenTokens.has(pageToken)) {
        throw new HeliosError("UPSTREAM_ERROR", "Cloud Logging returned a repeated pagination token.");
      }
      seenTokens.add(pageToken);
    }

    return {
      ...prepared,
      entries: entries.slice(0, scanLimit),
      partial: deadlineExceeded || pageToken !== undefined,
      deadlineExceeded,
      ...(pageToken === undefined ? {} : { nextPageToken: pageToken })
    };
  }

  private async prepare(input: BaseQueryInput): Promise<PreparedQuery> {
    const allowed = await this.getAllowedProjects();
    let projects = resolveProjects(input.projectIds, allowed);
    const traceProject = canonicalTraceProject(input.traceId);
    if (traceProject !== undefined && projects.includes(traceProject)) {
      projects = [traceProject];
    }
    const timeRange = resolveTimeRange(
      input,
      { maxWindowMs: this.config.maxQueryWindowMs, defaultLookbackMinutes: 60 },
      this.now()
    );
    return {
      projects,
      timeRange,
      filter: buildLoggingFilter(input, projects, timeRange)
    };
  }

  private getAllowedProjects(): Promise<string[]> {
    this.allowedProjectsPromise ??= this.config.defaultProjects.length > 0
      ? Promise.resolve([...new Set(this.config.defaultProjects)])
      : this.repository.getDefaultProjectId().then(projectId => [projectId]);
    return this.allowedProjectsPromise;
  }

  private enforceEntrySize(entry: NormalizedLogEntry): NormalizedLogEntry {
    if (byteLength(entry) <= this.config.maxEntryBytes) {
      return entry;
    }
    const compact: NormalizedLogEntry = {
      timestamp: entry.timestamp,
      receiveTimestamp: entry.receiveTimestamp,
      severity: entry.severity,
      resource: { labels: {} },
      labels: {},
      ...(entry.payload === undefined ? {} : { payloadOmitted: true }),
      entryTruncated: true
    };
    addIfFits(compact, () => {
      if (entry.resource.type !== undefined) compact.resource.type = truncateValue(entry.resource.type, 128);
    }, () => delete compact.resource.type, this.config.maxEntryBytes);
    addOptionalString(compact, "service", entry.service, 256, this.config.maxEntryBytes);
    addOptionalString(compact, "trace", entry.trace, 256, this.config.maxEntryBytes);
    addOptionalString(compact, "insertId", entry.insertId, 256, this.config.maxEntryBytes);
    addOptionalString(compact, "message", entry.message, 1_024, this.config.maxEntryBytes);
    if (entry.errorGroupIds !== undefined) {
      addIfFits(
        compact,
        () => { compact.errorGroupIds = entry.errorGroupIds?.slice(0, 5).map(value => truncateValue(value, 256)); },
        () => delete compact.errorGroupIds,
        this.config.maxEntryBytes
      );
    }
    if (entry.exception !== undefined) {
      const exception = {
        ...(entry.exception.type === undefined ? {} : { type: truncateValue(entry.exception.type, 256) }),
        ...(entry.exception.stack === undefined ? {} : { stack: compactStack(entry.exception.stack) })
      };
      addIfFits(
        compact,
        () => { compact.exception = exception; },
        () => delete compact.exception,
        this.config.maxEntryBytes
      );
    }
    addOptionalString(compact, "spanId", entry.spanId, 128, this.config.maxEntryBytes);
    addOptionalString(compact, "logName", entry.logName, 512, this.config.maxEntryBytes);
    return compact;
  }

  private enforceResponseSize(result: QueryLogsResult): QueryLogsResult {
    const budget = responseObjectBudget(this.config.maxResponseBytes);
    if (byteLength(result) <= budget) {
      return result;
    }
    const sourceEntries = result.entries;
    const metadata: QueryMetadata = {
      ...result.metadata,
      returnedEntries: 0,
      responseTruncated: true,
      droppedEntries: sourceEntries.length,
      paginationInvalidated: true
    };
    delete metadata.nextPageToken;
    const entries: NormalizedLogEntry[] = [];
    let projectedBytes = byteLength({ metadata, entries });
    for (const entry of sourceEntries) {
      const entryBytes = byteLength(entry) + (entries.length === 0 ? 0 : 1);
      if (projectedBytes + entryBytes > budget - 32) {
        break;
      }
      entries.push(entry);
      projectedBytes += entryBytes;
    }
    metadata.returnedEntries = entries.length;
    metadata.droppedEntries = sourceEntries.length - entries.length;
    const bounded = { metadata, entries };
    if (byteLength(bounded) > budget && entries.length > 0) {
      entries.pop();
      metadata.returnedEntries = entries.length;
      metadata.droppedEntries = sourceEntries.length - entries.length;
    }
    this.assertResponseSize(bounded);
    return bounded;
  }

  private assertResponseSize(result: unknown): void {
    if (byteLength(result) > responseObjectBudget(this.config.maxResponseBytes)) {
      throw new HeliosError(
        "RESOURCE_EXHAUSTED",
        "The result metadata exceeds HELIOS_MAX_RESPONSE_BYTES. Narrow the query or raise the configured limit."
      );
    }
  }

  private scanMetadata(scan: ScanResult): Record<string, unknown> {
    return {
      projects: scan.projects,
      timeRange: scan.timeRange,
      filter: scan.filter,
      scannedEntries: scan.entries.length,
      partial: scan.partial,
      deadlineExceeded: scan.deadlineExceeded,
      ...(scan.nextPageToken === undefined ? {} : { sourceNextPageToken: scan.nextPageToken })
    };
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HeliosError("INVALID_ARGUMENT", `${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function trimGroupsToSize(result: Record<string, unknown>, maximumBytes: number): void {
  const aggregation = result.aggregation;
  const metadata = result.metadata;
  if (
    aggregation === null ||
    typeof aggregation !== "object" ||
    !("groups" in aggregation) ||
    !Array.isArray(aggregation.groups) ||
    metadata === null ||
    typeof metadata !== "object"
  ) {
    return;
  }
  const budget = responseObjectBudget(maximumBytes);
  if (byteLength(result) <= budget) {
    return;
  }
  const sourceGroups = [...aggregation.groups];
  aggregation.groups.length = 0;
  Object.assign(metadata, { responseTruncated: true, droppedGroups: sourceGroups.length });
  let projectedBytes = byteLength(result);
  for (const group of sourceGroups) {
    const groupBytes = byteLength(group) + (aggregation.groups.length === 0 ? 0 : 1);
    if (projectedBytes + groupBytes > budget - 32) {
      break;
    }
    aggregation.groups.push(group);
    projectedBytes += groupBytes;
  }
  Object.assign(metadata, { droppedGroups: sourceGroups.length - aggregation.groups.length });
}

function validatePaginationWindow(input: QueryLogsInput): void {
  if (
    input.pageToken !== undefined &&
    (input.startTime === undefined || input.endTime === undefined || input.lookbackMinutes !== undefined)
  ) {
    throw new HeliosError(
      "INVALID_ARGUMENT",
      "A paginated query must reuse explicit startTime and endTime values from the first response metadata."
    );
  }
}

function responseObjectBudget(maximumWireBytes: number): number {
  // TextContent embeds the JSON result as a JSON string in the outer JSON-RPC
  // envelope. Reserve fixed protocol overhead and worst-case escaping growth.
  return Math.max(1, Math.floor((maximumWireBytes - 512) / 2));
}

function stricterSeverity(
  left: AggregateExceptionsInput["minSeverity"],
  right: NonNullable<AggregateExceptionsInput["minSeverity"]>
): NonNullable<AggregateExceptionsInput["minSeverity"]> {
  const order = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];
  if (left === undefined) return right;
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

function addOptionalString<K extends "service" | "trace" | "insertId" | "message" | "spanId" | "logName">(
  entry: NormalizedLogEntry,
  key: K,
  value: string | undefined,
  maximumLength: number,
  maximumBytes: number
): void {
  if (value === undefined) return;
  addIfFits(
    entry,
    () => { entry[key] = truncateValue(value, maximumLength); },
    () => { delete entry[key]; },
    maximumBytes
  );
}

function addIfFits(
  entry: NormalizedLogEntry,
  add: () => void,
  remove: () => void,
  maximumBytes: number
): void {
  add();
  if (byteLength(entry) > maximumBytes) {
    remove();
  }
}

function truncateValue(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength)}...[truncated]`;
}

function compactStack(stack: string): string {
  return stack
    .split(/\r?\n/)
    .slice(0, 8)
    .join("\n")
    .slice(0, 2_048);
}

function normalizeRedactionKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
}
