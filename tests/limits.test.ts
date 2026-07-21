import { describe, expect, it } from "vitest";
import { QueryInvocationLimiter } from "../src/limits.js";

describe("QueryInvocationLimiter", () => {
  it("limits each principal and tool within a fixed window", async () => {
    let now = 1_000;
    const limiter = new QueryInvocationLimiter({
      maxConcurrentQueries: 2,
      requestsPerWindow: 1,
      windowMs: 60_000,
      now: () => now
    });

    await expect(limiter.run("alice", "query_logs", async () => "ok")).resolves.toBe("ok");
    await expect(limiter.run("alice", "query_logs", async () => "blocked")).rejects.toMatchObject({
      code: "RESOURCE_EXHAUSTED",
      details: { retryAfterSeconds: 60 }
    });
    await expect(limiter.run("alice", "summarize_logs", async () => "ok")).resolves.toBe("ok");
    now += 60_000;
    await expect(limiter.run("alice", "query_logs", async () => "reset")).resolves.toBe("reset");
  });

  it("rejects work above the global concurrent query cap", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const limiter = new QueryInvocationLimiter({
      maxConcurrentQueries: 1,
      requestsPerWindow: 10,
      windowMs: 60_000
    });
    const first = limiter.run("alice", "query_logs", async () => held);

    await expect(limiter.run("bob", "query_logs", async () => undefined)).rejects.toMatchObject({
      code: "RESOURCE_EXHAUSTED"
    });
    release();
    await first;
  });
});
