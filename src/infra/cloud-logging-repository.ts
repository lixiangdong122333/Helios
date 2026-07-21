import { Logging } from "@google-cloud/logging";
import { HeliosError, errorMessage } from "../errors.js";
import type {
  ListLogEntriesPage,
  ListLogEntriesRequest,
  LogRepository,
  RawLogEntry
} from "../domain/types.js";

export class CloudLoggingRepository implements LogRepository {
  constructor(private readonly logging = new Logging()) {}

  async getDefaultProjectId(): Promise<string> {
    try {
      return await this.logging.auth.getProjectId();
    } catch (error) {
      throw mapGoogleError(error, "Unable to discover a Google Cloud project from ADC.");
    }
  }

  async listEntries(request: ListLogEntriesRequest): Promise<ListLogEntriesPage> {
    try {
      const [entries, nextRequest, apiResponse] = await this.logging.getEntries({
        autoPaginate: false,
        resourceNames: request.projectIds.map(projectId => `projects/${projectId}`),
        filter: request.filter,
        orderBy: `timestamp ${request.order}`,
        pageSize: request.pageSize,
        ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
        gaxOptions: { timeout: request.timeoutMs }
      });
      const normalized: RawLogEntry[] = entries.map(entry => ({
        metadata: (entry.metadata ?? {}) as Record<string, unknown>,
        data: entry.data
      }));
      // google-gax returns null at runtime on the terminal page even though the
      // handwritten package's tuple type currently declares this as non-null.
      const nextPageToken = nextRequest?.pageToken ?? apiResponse.nextPageToken ?? undefined;
      return {
        entries: normalized,
        ...(nextPageToken === undefined || nextPageToken === "" ? {} : { nextPageToken })
      };
    } catch (error) {
      throw mapGoogleError(error, "Cloud Logging entries.list failed.");
    }
  }

  async close(): Promise<void> {
    const clients = new Set<unknown>([
      this.logging.loggingService,
      this.logging.configService,
      ...Object.values(this.logging.api)
    ]);
    const results = await Promise.allSettled(
      [...clients].map(async client => {
        if (client !== null && typeof client === "object" && "close" in client && typeof client.close === "function") {
          await (client.close as () => Promise<void>).call(client);
        }
      })
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map(failure => failure.reason), "Failed to close Google Cloud clients.");
    }
  }
}

function mapGoogleError(error: unknown, prefix: string): HeliosError {
  const code = getErrorCode(error);
  const message = `${prefix} ${errorMessage(error)}`;
  if (code === 4) return new HeliosError("DEADLINE_EXCEEDED", message, undefined, { cause: error });
  if (code === 7 || code === 16) return new HeliosError("PERMISSION_DENIED", message, undefined, { cause: error });
  if (code === 8) return new HeliosError("RESOURCE_EXHAUSTED", message, undefined, { cause: error });
  return new HeliosError("UPSTREAM_ERROR", message, undefined, { cause: error });
}

function getErrorCode(error: unknown): number | undefined {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "number") {
    return error.code;
  }
  return undefined;
}
