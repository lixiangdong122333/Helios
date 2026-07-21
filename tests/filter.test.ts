import { describe, expect, it } from "vitest";

import { HeliosError } from "../src/errors.js";
import {
  buildLoggingFilter,
  buildServiceFilter,
  buildTraceFilter,
  quoteFilterLiteral,
  resolveProjects,
  resolveTimeRange
} from "../src/domain/filter.js";

describe("Cloud Logging filter construction", () => {
  it("escapes user-controlled literals using JSON string rules", () => {
    expect(quoteFilterLiteral("quoted \"value\"\\path\nnext")).toBe(
      '"quoted \\"value\\"\\\\path\\nnext"'
    );

    const filter = buildLoggingFilter(
      {
        searchText: 'status = "failed"\\retry\nnow',
        resourceTypes: ["cloud_run_revision", "k8s_container"],
        minSeverity: "WARNING"
      },
      ["alpha-project"],
      {
        startTime: "2026-07-17T01:00:00.000Z",
        endTime: "2026-07-17T02:00:00.000Z"
      }
    );

    expect(filter).toContain('SEARCH("status = \\"failed\\"\\\\retry\\nnow")');
    expect(filter).toContain(
      '(resource.type = "cloud_run_revision" OR resource.type = "k8s_container")'
    );
    expect(filter).toContain("severity >= WARNING");
  });

  it("resolves deterministic lookback and explicit RFC 3339 ranges", () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    const policy = { maxWindowMs: 24 * 60 * 60 * 1_000, defaultLookbackMinutes: 60 };

    expect(resolveTimeRange({}, policy, now)).toEqual({
      startTime: "2026-07-17T11:00:00.000Z",
      endTime: "2026-07-17T12:00:00.000Z"
    });
      expect(
      resolveTimeRange(
        {
          startTime: "2026-07-17T08:00:00+08:00",
          endTime: "2026-07-17T09:30:00+08:00"
        },
        policy,
        now
      )
    ).toEqual({
      startTime: "2026-07-17T00:00:00.000Z",
      endTime: "2026-07-17T01:30:00.000Z"
    });
  });

  it("rejects ambiguous, unzoned, reversed, and overlong time ranges", () => {
    const policy = { maxWindowMs: 60 * 60 * 1_000, defaultLookbackMinutes: 60 };

    expect(() =>
      resolveTimeRange(
        { startTime: "2026-07-17T00:00:00Z", lookbackMinutes: 10 },
        policy
      )
    ).toThrowError(/either startTime or lookbackMinutes/);
    expect(() =>
      resolveTimeRange(
        { startTime: "2026-07-17T00:00:00", endTime: "2026-07-17T01:00:00Z" },
        policy
      )
    ).toThrowError(/timezone/);
    expect(() =>
      resolveTimeRange(
        { startTime: "2026-07-17T02:00:00Z", endTime: "2026-07-17T01:00:00Z" },
        policy
      )
    ).toThrowError(/earlier than/);
    expect(() =>
      resolveTimeRange(
        { startTime: "2026-07-16T23:59:59Z", endTime: "2026-07-17T01:00:00Z" },
        policy
      )
    ).toThrowError(/exceeds the configured maximum/);
  });

  it("defaults to the allowlist, deduplicates requests, and rejects unauthorized projects", () => {
    const allowed = ["alpha-project", "bravo-project"];

    expect(resolveProjects(undefined, allowed)).toEqual(allowed);
    expect(resolveProjects(["bravo-project", "bravo-project"], allowed)).toEqual([
      "bravo-project"
    ]);

    expectProjectError(() => resolveProjects(["not_allowed!"], allowed), "INVALID_ARGUMENT");
    expectProjectError(() => resolveProjects(["charlie-project"], allowed), "PERMISSION_DENIED");
    expectProjectError(() => resolveProjects(undefined, []), "INTERNAL_ERROR");
  });

  it("builds raw and canonical trace filters without crossing project boundaries", () => {
    const rawTrace = "ABCDEF0123456789ABCDEF0123456789";

    expect(buildTraceFilter(rawTrace, ["alpha-project", "bravo-project"])).toBe(
      '(trace = "abcdef0123456789abcdef0123456789" OR ' +
        'trace = "projects/alpha-project/traces/abcdef0123456789abcdef0123456789" OR ' +
        'trace = "projects/bravo-project/traces/abcdef0123456789abcdef0123456789")'
    );
    expect(
      buildTraceFilter(
        "projects/alpha-project/traces/ABCDEF0123456789ABCDEF0123456789",
        ["alpha-project"]
      )
      ).toBe(
        '(trace = "projects/alpha-project/traces/abcdef0123456789abcdef0123456789")'
      );

    expectProjectError(
      () =>
        buildTraceFilter(
          "projects/bravo-project/traces/abcdef0123456789abcdef0123456789",
          ["alpha-project"]
        ),
      "PERMISSION_DENIED"
    );
    expectProjectError(() => buildTraceFilter("not-a-trace", ["alpha-project"]), "INVALID_ARGUMENT");
  });

  it("maps service selectors to platform fields and escapes qualifiers", () => {
    expect(
      buildServiceFilter({
        name: 'checkout"api',
        platform: "cloud_run",
        namespace: 'prod\\blue',
        location: "us-central1"
      })
    ).toBe(
      '((resource.type = "cloud_run_revision" AND resource.labels.service_name = "checkout\\"api") ' +
        'AND resource.labels.namespace_name = "prod\\\\blue" AND ' +
        'resource.labels.location = "us-central1")'
    );

    const automatic = buildServiceFilter({ name: "orders" });
    expect(automatic).toContain('resource.type = "cloud_run_revision"');
    expect(automatic).toContain('resource.type = "k8s_container"');
    expect(automatic).toContain('resource.type = "gae_app"');
    expect(automatic).toContain('jsonPayload.serviceName = "orders"');
  });
});

function expectProjectError(action: () => unknown, code: HeliosError["code"]): void {
  try {
    action();
    throw new Error("Expected HeliosError");
  } catch (error) {
    expect(error).toBeInstanceOf(HeliosError);
    expect(error).toMatchObject({ code });
  }
}
