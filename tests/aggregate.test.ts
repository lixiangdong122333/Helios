import { describe, expect, it } from "vitest";

import { aggregateExceptions, summarizeLogs } from "../src/domain/aggregate.js";
import type { NormalizedLogEntry } from "../src/domain/types.js";

describe("exception aggregation", () => {
  it("uses a stable normalized fingerprint and accumulates group dimensions", () => {
    const first = logEntry({
      timestamp: "2026-07-17T01:05:00.000Z",
      severity: "ERROR",
      service: "payments",
      trace: "trace-b",
      insertId: "insert-1",
      message: "Request 12345 failed",
      payload: {
        error: {
          type: "TypeError",
          stack: "TypeError: bad input\n    at charge (/srv/pay.js:10:2)\n    at main (/srv/app.js:20:3)"
        }
      }
    });
    const second = logEntry({
      timestamp: "2026-07-17T01:01:00.000Z",
      severity: "CRITICAL",
      service: "checkout",
      trace: "trace-a",
      insertId: "insert-2",
      message: "Request 987654 failed",
      payload: {
        error: {
          type: "TypeError",
          stack: "TypeError: bad input\n    at charge (/srv/pay.js:999:8)\n    at main (/srv/app.js:81:9)"
        }
      }
    });

    const result = aggregateExceptions([first, second], 10, 2);

    expect(result).toMatchObject({
      processedEntries: 2,
      matchedExceptions: 2,
      groupCount: 1
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      exceptionType: "TypeError",
      normalizedMessage: "Request <number> failed",
      count: 2,
      firstSeen: "2026-07-17T01:01:00.000Z",
      lastSeen: "2026-07-17T01:05:00.000Z",
      services: ["checkout", "payments"],
      severities: ["CRITICAL", "ERROR"],
      traces: ["trace-a", "trace-b"]
    });
    expect(result.groups[0]?.fingerprint).toMatch(/^[0-9a-f]{20}$/);
    expect(result.groups[0]?.samples).toHaveLength(2);
  });

  it("reports all groups and matches while applying output and sample limits", () => {
    const repeated = [
      logEntry({ severity: "ERROR", message: "DatabaseFailure: unavailable" }),
      logEntry({ severity: "ERROR", message: "DatabaseFailure: unavailable" })
    ];
    const distinct = logEntry({
      severity: "INFO",
      message: "Cache error",
      payload: { stack: "CacheError: miss\n    at read (/srv/cache.js:12:4)" }
    });
    const ignored = logEntry({ severity: "INFO", message: "request completed" });

    const result = aggregateExceptions([...repeated, distinct, ignored], 1, 0);

    expect(result).toMatchObject({
      processedEntries: 4,
      matchedExceptions: 3,
      groupCount: 2
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ count: 2, samples: [] });
  });

  it("uses stack frames embedded in multiline text payloads", () => {
    const first = logEntry({
      severity: "ERROR",
      message: "TypeError: failed\n    at alpha (/srv/alpha.js:10:2)"
    });
    const second = logEntry({
      severity: "ERROR",
      message: "TypeError: failed\n    at beta (/srv/beta.js:10:2)"
    });

    const result = aggregateExceptions([first, second], 10, 1);

    expect(result.groupCount).toBe(2);
  });

  it("counts prototype-shaped service names safely", () => {
    const summary = summarizeLogs([
      logEntry({ service: "constructor" }),
      logEntry({ service: "__proto__" }),
      logEntry({ service: "constructor" })
    ], 10);

    expect(summary.topServices).toEqual([
      { value: "constructor", count: 2 },
      { value: "__proto__", count: 1 }
    ]);
  });
});

function logEntry(overrides: Partial<NormalizedLogEntry>): NormalizedLogEntry {
  return {
    timestamp: "2026-07-17T01:00:00.000Z",
    receiveTimestamp: null,
    severity: "DEFAULT",
    resource: { labels: {} },
    labels: {},
    ...overrides
  };
}
