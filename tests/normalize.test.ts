import { describe, expect, it } from "vitest";

import {
  defaultNormalizationPolicy,
  normalizeLogEntry,
  toJsonValue
} from "../src/domain/normalize.js";

describe("log entry normalization", () => {
  it("redacts normalized secret-key variants recursively and marks cycles", () => {
    const value: Record<string, unknown> = {
      Authorization: "Bearer private",
      nested: {
        "Set-Cookie": "session=private",
        API_KEY: "private-key",
        accessToken: "private-token",
        "x-api-key": "private-header-key",
        clientSecret: "private-secret",
        visible: "kept"
      }
    };
    value.self = value;

    expect(toJsonValue(value)).toEqual({
      Authorization: "[REDACTED]",
      nested: {
        "Set-Cookie": "[REDACTED]",
        API_KEY: "[REDACTED]",
        accessToken: "[REDACTED]",
        "x-api-key": "[REDACTED]",
        clientSecret: "[REDACTED]",
        visible: "kept"
      },
      self: "[circular]"
    });
  });

  it("redacts and bounds resource and entry labels", () => {
    const entry = normalizeLogEntry(
      {
        metadata: {
          resource: { labels: { service_name: "orders", accessToken: "secret" } },
          labels: { "x-api-key": "secret", visible: "123456" }
        },
        data: { serviceContext: { service: "error-reporter" }, message: "failed" }
      },
      true,
      { ...defaultNormalizationPolicy, maxStringLength: 4 }
    );

    expect(entry.resource.labels).toEqual({ service_name: "orde...[truncated 2 chars]", accessToken: "[REDACTED]" });
    expect(entry.labels).toEqual({ "x-api-key": "[REDACTED]", visible: "1234...[truncated 2 chars]" });
    expect(entry.service).toBe("orde...[truncated 2 chars]");
  });

  it("normalizes cyclic arrays without throwing", () => {
    const cyclic: unknown[] = ["first"];
    cyclic.push(cyclic);

    expect(toJsonValue(cyclic)).toEqual(["first", "[circular]"]);
  });

  it("extracts useful fields while omitting the payload on request", () => {
    const entry = normalizeLogEntry(
      {
        metadata: {
          timestamp: { seconds: "1784250000", nanos: 500_000_000 },
          receiveTimestamp: new Date("2026-07-17T01:00:01.000Z"),
          severity: "ERROR",
          insertId: 42,
          resource: {
            type: "cloud_run_revision",
            labels: { service_name: "checkout", revision_name: 7 }
          },
          labels: { tenant: 123 },
          httpRequest: { Authorization: "private", status: 500 }
        },
        data: { message: "payment failed", password: "private" }
      },
      false
    );

    expect(entry).toMatchObject({
      timestamp: "2026-07-17T01:00:00.500Z",
      receiveTimestamp: "2026-07-17T01:00:01.000Z",
      severity: "ERROR",
      insertId: "42",
      resource: {
        type: "cloud_run_revision",
        labels: { service_name: "checkout", revision_name: "7" }
      },
      labels: { tenant: "123" },
      service: "checkout",
      message: "payment failed",
      httpRequest: { Authorization: "[REDACTED]", status: 500 }
    });
    expect(entry).not.toHaveProperty("payload");
  });

  it("honors deterministic depth and length limits", () => {
    const policy = {
      ...defaultNormalizationPolicy,
      redactedKeys: new Set(defaultNormalizationPolicy.redactedKeys),
      maxStringLength: 4,
      maxDepth: 2
    };

    expect(toJsonValue({ message: "123456", child: { nested: { value: true } } }, policy)).toEqual({
      message: "1234...[truncated 2 chars]",
      child: { nested: "[maximum depth reached]" }
    });
  });
});
