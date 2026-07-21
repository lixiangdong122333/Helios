import { HeliosError } from "./errors.js";

export interface InvocationLimiter {
  run<T>(principal: string, tool: string, operation: () => Promise<T>): Promise<T>;
}

export interface InvocationLimitOptions {
  maxConcurrentQueries: number;
  requestsPerWindow: number;
  windowMs: number;
  now?: () => number;
}

interface RateBucket {
  count: number;
  windowStartedAt: number;
}

export class QueryInvocationLimiter implements InvocationLimiter {
  private activeQueries = 0;
  private readonly buckets = new Map<string, RateBucket>();
  private readonly now: () => number;

  constructor(private readonly options: InvocationLimitOptions) {
    this.now = options.now ?? Date.now;
  }

  async run<T>(principal: string, tool: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeQueries >= this.options.maxConcurrentQueries) {
      throw new HeliosError(
        "RESOURCE_EXHAUSTED",
        "Helios is at its concurrent query limit. Retry after an active query completes."
      );
    }
    this.consumeRateLimit(`${principal}\0${tool}`);
    this.activeQueries += 1;
    try {
      return await operation();
    } finally {
      this.activeQueries -= 1;
    }
  }

  private consumeRateLimit(key: string): void {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined || now - bucket.windowStartedAt >= this.options.windowMs) {
      bucket = { count: 0, windowStartedAt: now };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.options.requestsPerWindow) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStartedAt + this.options.windowMs - now) / 1_000));
      throw new HeliosError(
        "RESOURCE_EXHAUSTED",
        "The per-principal tool rate limit has been reached.",
        { retryAfterSeconds }
      );
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) {
      for (const [bucketKey, candidate] of this.buckets) {
        if (now - candidate.windowStartedAt >= this.options.windowMs) {
          this.buckets.delete(bucketKey);
        }
      }
      while (this.buckets.size > 10_000) {
        const oldestKey = this.buckets.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        this.buckets.delete(oldestKey);
      }
    }
  }
}

export const unlimitedInvocationLimiter: InvocationLimiter = {
  run: async <T>(_principal: string, _tool: string, operation: () => Promise<T>): Promise<T> => operation()
};
