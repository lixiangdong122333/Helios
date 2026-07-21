import type { Logging } from "@google-cloud/logging";
import { describe, expect, it, vi } from "vitest";
import { CloudLoggingRepository } from "../src/infra/cloud-logging-repository.js";

const request = {
  projectIds: ["test-project"],
  filter: 'timestamp >= "2026-07-17T00:00:00.000Z"',
  order: "desc" as const,
  pageSize: 10,
  timeoutMs: 5_000
};

describe("CloudLoggingRepository", () => {
  it("accepts google-gax's runtime null next request on a terminal page", async () => {
    const getEntries = vi.fn().mockResolvedValue([[], null, {}]);
    const repository = new CloudLoggingRepository({ getEntries } as unknown as Logging);

    await expect(repository.listEntries(request)).resolves.toEqual({ entries: [] });
  });

  it("returns the next token and maps Entry wrappers", async () => {
    const getEntries = vi.fn().mockResolvedValue([
      [{ metadata: { severity: "INFO" }, data: { message: "ok" } }],
      { pageToken: "next-page" },
      { nextPageToken: "next-page" }
    ]);
    const repository = new CloudLoggingRepository({ getEntries } as unknown as Logging);

    await expect(repository.listEntries(request)).resolves.toEqual({
      entries: [{ metadata: { severity: "INFO" }, data: { message: "ok" } }],
      nextPageToken: "next-page"
    });
  });
});
