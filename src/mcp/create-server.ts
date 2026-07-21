import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { LogQueryService } from "../application/log-query-service.js";
import type {
  AggregateExceptionsInput,
  GetTraceLogsInput,
  QueryLogsInput,
  SummarizeLogsInput
} from "../domain/types.js";
import { severityValues } from "../domain/types.js";
import { HeliosError } from "../errors.js";
import { auditHash, type Logger } from "../logger.js";
import { unlimitedInvocationLimiter, type InvocationLimiter } from "../limits.js";
import { HELIOS_VERSION } from "../version.js";

export interface HeliosServerDependencies {
  queryService: LogQueryService;
  logger: Logger;
  invocationLimiter?: InvocationLimiter;
}

const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const traceIdSchema = z
  .string()
  .max(200)
  .refine(
    value => /^[0-9a-f]{32}$/i.test(value) || /^projects\/[^/]+\/traces\/[0-9a-f]{32}$/i.test(value),
    "Use a 32-character hexadecimal trace ID or a canonical projects/.../traces/... value."
  );
const serviceSchema = z.object({
  name: z.string().min(1).max(128),
  platform: z.enum(["auto", "cloud_run", "gke", "app_engine", "generic"]).optional(),
  namespace: z.string().min(1).max(128).optional(),
  cluster: z.string().min(1).max(128).optional(),
  location: z.string().min(1).max(128).optional()
});
const commonQueryShape = {
  projectIds: z.array(projectIdSchema).max(20).optional().describe("Configured Google Cloud project IDs to query."),
  startTime: z.iso.datetime({ offset: true }).optional().describe("Inclusive RFC 3339 start timestamp."),
  endTime: z.iso.datetime({ offset: true }).optional().describe("Exclusive RFC 3339 end timestamp."),
  lookbackMinutes: z.number().int().positive().max(10_080).optional().describe("Relative range ending at endTime or now."),
  traceId: traceIdSchema.optional(),
  service: serviceSchema.optional(),
  minSeverity: z.enum(severityValues).optional(),
  resourceTypes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)).max(20).optional(),
  searchText: z.string().min(1).max(500).optional().describe("A safely escaped Cloud Logging SEARCH expression.")
};
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

export function createHeliosMcpServer(dependencies: HeliosServerDependencies): McpServer {
  const server = new McpServer({ name: "helios-cloud-logging", version: HELIOS_VERSION });

  server.registerTool(
    "query_logs",
    {
      title: "Query Cloud Logs",
      description: "Query normalized Google Cloud Logging entries with bounded time, trace, service, severity, and text filters.",
      inputSchema: {
        ...commonQueryShape,
        limit: z.number().int().positive().max(1_000).default(100),
        order: z.enum(["asc", "desc"]).default("desc"),
        pageToken: z.string().min(1).max(8_192).optional(),
        includePayload: z.boolean().default(false)
      },
      annotations
    },
    async (args, extra) => runTool("query_logs", extra.authInfo?.clientId, dependencies, () =>
      dependencies.queryService.queryLogs(args as QueryLogsInput)
    )
  );

  server.registerTool(
    "get_trace_logs",
    {
      title: "Get Trace Logs",
      description: "Retrieve logs matching the canonical Cloud Logging trace field, ordered chronologically by default.",
      inputSchema: {
        ...commonQueryShape,
        traceId: traceIdSchema,
        limit: z.number().int().positive().max(1_000).default(200),
        order: z.enum(["asc", "desc"]).default("asc"),
        pageToken: z.string().min(1).max(8_192).optional(),
        includePayload: z.boolean().default(false)
      },
      annotations
    },
    async (args, extra) => runTool("get_trace_logs", extra.authInfo?.clientId, dependencies, () =>
      dependencies.queryService.getTraceLogs(args as GetTraceLogsInput)
    )
  );

  server.registerTool(
    "summarize_logs",
    {
      title: "Summarize Cloud Logs",
      description: "Scan a bounded set of log entries and summarize severity, service, resource type, and observed time range.",
      inputSchema: {
        ...commonQueryShape,
        scanLimit: z.number().int().positive().max(50_000).optional(),
        topServices: z.number().int().positive().max(100).default(20)
      },
      annotations
    },
    async (args, extra) => runTool("summarize_logs", extra.authInfo?.clientId, dependencies, () =>
      dependencies.queryService.summarize(args as SummarizeLogsInput)
    )
  );

  server.registerTool(
    "aggregate_exceptions",
    {
      title: "Aggregate Exceptions",
      description: "Scan bounded logs, fingerprint exceptions, and report observed counts, affected services, traces, and samples.",
      inputSchema: {
        ...commonQueryShape,
        scanLimit: z.number().int().positive().max(50_000).optional(),
        includeNonErrorSeverity: z.boolean().default(false),
        groupLimit: z.number().int().positive().max(200).default(50),
        samplesPerGroup: z.number().int().min(0).max(10).default(3)
      },
      annotations
    },
    async (args, extra) => runTool("aggregate_exceptions", extra.authInfo?.clientId, dependencies, () =>
      dependencies.queryService.aggregateExceptions(args as AggregateExceptionsInput)
    )
  );

  return server;
}

async function runTool(
  tool: string,
  principal: string | undefined,
  dependencies: HeliosServerDependencies,
  operation: () => Promise<unknown>
): Promise<CallToolResult> {
  const startedAt = performance.now();
  const principalHash = auditHash(principal ?? "stdio-local");
  try {
    const result = await (dependencies.invocationLimiter ?? unlimitedInvocationLimiter).run(
      principal ?? "stdio-local",
      tool,
      operation
    );
    const objectResult = asRecord(result);
    dependencies.logger.info("mcp_tool_completed", {
      tool,
      principalHash,
      durationMs: Math.round(performance.now() - startedAt),
      filterHash: getFilterHash(objectResult),
      outcome: "success"
    });
    return {
      content: [{ type: "text", text: JSON.stringify(objectResult) }]
    };
  } catch (error) {
    const publicError = error instanceof HeliosError
      ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
      : { code: "INTERNAL_ERROR", message: "Helios could not complete the Cloud Logging query." };
    dependencies.logger.error("mcp_tool_failed", {
      tool,
      principalHash,
      durationMs: Math.round(performance.now() - startedAt),
      outcome: "error",
      errorCode: publicError.code,
      errorType: error instanceof HeliosError ? error.code : error instanceof Error ? error.name : "unknown"
    });
    const body = { error: publicError };
    return {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
      isError: true
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

function getFilterHash(result: Record<string, unknown>): string | undefined {
  const metadata = result.metadata;
  if (metadata !== null && typeof metadata === "object" && "filter" in metadata && typeof metadata.filter === "string") {
    return auditHash(metadata.filter);
  }
  return undefined;
}
