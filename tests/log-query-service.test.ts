import { describe, expect, it, vi } from "vitest";

import { LogQueryService } from "../src/application/log-query-service.js";
import type { LoggingConfig } from "../src/config.js";
import type {
  ListLogEntriesPage,
  ListLogEntriesRequest,
  LogRepository,
  RawLogEntry
} from "../src/domain/types.js";
import { HeliosError } from "../src/errors.js";

describe("LogQueryService", () => {
  it("forwards query pagination and bounds to the repository", async () => {
    const repository = new FakeLogRepository([
      {
        entries: [rawEntry("one")],
        nextPageToken: "cursor-next"
      }
    ]);
    const service = createService(repository);

    const result = await service.queryLogs({
      startTime: "2026-07-17T00:00:00Z",
      endTime: "2026-07-17T01:00:00Z",
      limit: 2,
      order: "asc",
      pageToken: "cursor-current"
    });

    expect(repository.requests).toHaveLength(1);
    expect(repository.requests[0]).toMatchObject({
      projectIds: ["alpha-project"],
      order: "asc",
      pageSize: 2,
      pageToken: "cursor-current",
      timeoutMs: 5_000
    });
    expect(repository.requests[0]?.filter).toContain('timestamp >= "2026-07-17T00:00:00.000Z"');
    expect(result.metadata).toMatchObject({
      returnedEntries: 1,
      nextPageToken: "cursor-next",
      responseTruncated: false,
      droppedEntries: 0
    });
  });

  it("paginates scans to completion without marking a complete result partial", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const repository = new FakeLogRepository([
      { entries: [rawEntry("one"), rawEntry("two")], nextPageToken: "scan-page-2" },
      { entries: [rawEntry("three")] }
    ]);
    const service = createService(repository);

    const result = await service.summarize({ scanLimit: 5 });

    expect(repository.requests).toHaveLength(2);
    expect(repository.requests[0]).toMatchObject({ pageSize: 5, timeoutMs: 5_000 });
    expect(repository.requests[0]).not.toHaveProperty("pageToken");
    expect(repository.requests[1]).toMatchObject({
      pageSize: 3,
      pageToken: "scan-page-2",
      timeoutMs: 5_000
    });
    expect(result.metadata).toMatchObject({
      scannedEntries: 3,
      partial: false,
      deadlineExceeded: false
    });
    expect(result.metadata).not.toHaveProperty("sourceNextPageToken");
  });

  it("returns accumulated entries as partial when a later page times out", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const repository = new FakeLogRepository([
      { entries: [rawEntry("one")], nextPageToken: "resume-here" },
      new HeliosError("DEADLINE_EXCEEDED", "upstream deadline")
    ]);
    const service = createService(repository);

    const result = await service.summarize({ scanLimit: 5 });

    expect(result.metadata).toMatchObject({
      scannedEntries: 1,
      partial: true,
      deadlineExceeded: true,
      sourceNextPageToken: "resume-here"
    });
  });

  it("marks a scan partial when the configured scan limit leaves a source page token", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const repository = new FakeLogRepository([
      {
        entries: [rawEntry("one"), rawEntry("two")],
        nextPageToken: "more-results"
      }
    ]);
    const service = createService(repository);

    const result = await service.summarize({ scanLimit: 2 });

    expect(result.metadata).toMatchObject({
      scannedEntries: 2,
      partial: true,
      deadlineExceeded: false,
      sourceNextPageToken: "more-results"
    });
  });

  it("rejects repeated pagination tokens instead of looping", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const repository = new FakeLogRepository([
      { entries: [rawEntry("one")], nextPageToken: "same-token" },
      { entries: [rawEntry("two")], nextPageToken: "same-token" }
    ]);
    const service = createService(repository);

    await expect(service.summarize({ scanLimit: 5 })).rejects.toMatchObject({
      code: "UPSTREAM_ERROR"
    });
  });

  it("omits oversized payloads and truncates oversized responses", async () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      rawEntry(`entry-${index}-${"m".repeat(500)}`, { detail: "x".repeat(2_000) })
    );
    const repository = new FakeLogRepository([{ entries, nextPageToken: "unsafe-next-page" }]);
    const service = createService(repository, {
      maxEntryBytes: 700,
      maxResponseBytes: 4_000
    });

    const result = await service.queryLogs({ limit: 8, includePayload: true });

    expect(result.entries.length).toBeLessThan(8);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every(entry => entry.payload === undefined)).toBe(true);
    expect(result.entries.every(entry => entry.payloadOmitted === true)).toBe(true);
    expect(result.metadata).toMatchObject({
      returnedEntries: result.entries.length,
      responseTruncated: true,
      droppedEntries: 8 - result.entries.length,
      paginationInvalidated: true
    });
    expect(result.metadata).not.toHaveProperty("nextPageToken");
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(1_744);
  });

  it("requires an absolute time window when continuing with a page token", async () => {
    const repository = new FakeLogRepository([{ entries: [] }]);
    const service = createService(repository);

    await expect(service.queryLogs({ pageToken: "next", lookbackMinutes: 15 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT"
    });
    expect(repository.requests).toHaveLength(0);
  });

  it("preserves a caller severity stricter than ERROR for exception aggregation", async () => {
    const repository = new FakeLogRepository([{ entries: [] }]);
    const service = createService(repository);

    await service.aggregateExceptions({ minSeverity: "CRITICAL", scanLimit: 1 });

    expect(repository.requests[0]?.filter).toContain("severity >= CRITICAL");
  });

  it("narrows canonical trace queries to the trace's project", async () => {
    const repository = new FakeLogRepository([{ entries: [] }]);
    const service = createService(repository, { defaultProjects: ["alpha-project", "bravo-project"] });

    await service.queryLogs({
      traceId: "projects/bravo-project/traces/abcdef0123456789abcdef0123456789",
      limit: 1
    });

    expect(repository.requests[0]?.projectIds).toEqual(["bravo-project"]);
    expect(repository.requests[0]?.filter).not.toContain('trace = "abcdef0123456789abcdef0123456789"');
  });

  it("discovers the ADC default project once and reuses the allowlist", async () => {
    const repository = new FakeLogRepository([{ entries: [] }, { entries: [] }]);
    const service = createService(repository, { defaultProjects: [] });

    await service.queryLogs({ limit: 1 });
    await service.queryLogs({ limit: 1 });

    expect(repository.defaultProjectCalls).toBe(1);
    expect(repository.requests.map(request => request.projectIds)).toEqual([
      ["alpha-project"],
      ["alpha-project"]
    ]);
  });
});

class FakeLogRepository implements LogRepository {
  readonly requests: ListLogEntriesRequest[] = [];
  defaultProjectCalls = 0;

  constructor(
    private readonly outcomes: Array<ListLogEntriesPage | Error>,
    private readonly defaultProjectId = "alpha-project"
  ) {}

  async getDefaultProjectId(): Promise<string> {
    this.defaultProjectCalls += 1;
    return this.defaultProjectId;
  }

  async listEntries(request: ListLogEntriesRequest): Promise<ListLogEntriesPage> {
    this.requests.push(request);
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome ?? { entries: [] };
  }
}

function createService(
  repository: LogRepository,
  overrides: Partial<LoggingConfig> = {}
): LogQueryService {
  const config: LoggingConfig = {
    defaultProjects: ["alpha-project"],
    maxQueryWindowMs: 24 * 60 * 60 * 1_000,
    maxQueryEntries: 10,
    maxScanEntries: 10,
    maxResponseBytes: 100_000,
    maxEntryBytes: 10_000,
    queryTimeoutMs: 5_000,
    redactedKeys: [],
    ...overrides
  };
  return new LogQueryService(repository, config, () => new Date("2026-07-17T01:00:00.000Z"));
}

function rawEntry(message: string, extraPayload: Record<string, unknown> = {}): RawLogEntry {
  return {
    metadata: {
      timestamp: "2026-07-17T00:30:00.000Z",
      receiveTimestamp: "2026-07-17T00:30:01.000Z",
      severity: "ERROR",
      resource: {
        type: "cloud_run_revision",
        labels: { service_name: "checkout" }
      },
      labels: {}
    },
    data: { message, ...extraPayload }
  };
}
