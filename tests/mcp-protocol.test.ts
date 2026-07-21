import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LogQueryService } from "../src/application/log-query-service.js";
import type { HttpConfig, LoggingConfig } from "../src/config.js";
import type { ListLogEntriesRequest, LogRepository, RawLogEntry } from "../src/domain/types.js";
import type { Logger } from "../src/logger.js";
import { createHeliosMcpServer } from "../src/mcp/create-server.js";
import { startHttpServer, type HttpServerHandle } from "../src/transports/http.js";

const token = "test-token-that-is-at-least-thirty-two-characters";
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};
const loggingConfig: LoggingConfig = {
  defaultProjects: ["test-project"],
  maxQueryWindowMs: 24 * 60 * 60 * 1_000,
  maxQueryEntries: 1_000,
  maxScanEntries: 5_000,
  maxResponseBytes: 1_000_000,
  maxEntryBytes: 64_000,
  queryTimeoutMs: 30_000,
  redactedKeys: []
};

class FakeRepository implements LogRepository {
  readonly requests: ListLogEntriesRequest[] = [];

  constructor(private readonly entries: RawLogEntry[] = [defaultRawEntry()]) {}

  async getDefaultProjectId(): Promise<string> {
    return "test-project";
  }

  async listEntries(request: ListLogEntriesRequest) {
    this.requests.push(request);
    return {
      entries: this.entries
    };
  }
}

function createServer(repository = new FakeRepository(), overrides: Partial<LoggingConfig> = {}) {
  const service = new LogQueryService(
    repository,
    { ...loggingConfig, ...overrides },
    () => new Date("2026-07-17T02:00:00.000Z")
  );
  return createHeliosMcpServer({ queryService: service, logger });
}

function defaultRawEntry(): RawLogEntry {
  return {
    metadata: {
      timestamp: new Date("2026-07-17T01:30:00.000Z"),
      severity: "ERROR",
      resource: { type: "cloud_run_revision", labels: { service_name: "payments" } },
      trace: "0123456789abcdef0123456789abcdef"
    },
    data: { message: "Payment failed", password: "do-not-return" }
  };
}

describe("MCP protocol", () => {
  it("lists and calls all Helios tools over the in-memory MCP transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: "helios-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      "aggregate_exceptions",
      "get_trace_logs",
      "query_logs",
      "summarize_logs"
    ]);

    const result = await client.callTool({
      name: "query_logs",
      arguments: { lookbackMinutes: 30, includePayload: true }
    });
    expect(result.isError).not.toBe(true);
    expect(parseTextResult(result)).toMatchObject({
      metadata: { returnedEntries: 1 },
      entries: [{ service: "payments", payload: { password: "[REDACTED]" } }]
    });

    await client.close();
    await server.close();
  });

  it("returns a structured tool error for a project outside the allowlist", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: "helios-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "query_logs",
      arguments: { projectIds: ["other-project"], lookbackMinutes: 30 }
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "PERMISSION_DENIED" } });

    await client.close();
    await server.close();
  });

  it("keeps the encoded MCP result within the configured wire budget", async () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      ...defaultRawEntry(),
      data: { message: `entry-${index}-${'"\\'.repeat(600)}`, detail: "x".repeat(2_000) }
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(new FakeRepository(entries), {
      maxEntryBytes: 900,
      maxResponseBytes: 4_000
    });
    const client = new Client({ name: "helios-budget-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "query_logs",
      arguments: { limit: 10, includePayload: true }
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4_000);
    expect(parseTextResult(result)).toMatchObject({ metadata: { responseTruncated: true } });
    await client.close();
    await server.close();
  });
});

describe("authenticated Streamable HTTP", () => {
  let handle: HttpServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("rejects anonymous calls, publishes metadata, validates Origin, and serves an MCP client", async () => {
    const config: HttpConfig = {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      publicUrl: "http://127.0.0.1:3000/mcp",
      allowedHosts: [],
      allowedOrigins: ["https://allowed.example"],
      preAuthRateLimitRequests: 100,
      preAuthRateLimitWindowMs: 60_000,
      auth: { mode: "static", tokens: { test: token } }
    };
    handle = await startHttpServer(config, () => createServer(), logger);
    const baseUrl = new URL(handle.url);

    const anonymous = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).not.toContain("resource_metadata=");

    const invalidToken = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(invalidToken.status).toBe(401);

    const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", baseUrl);
    const metadata = await fetch(metadataUrl);
    expect(metadata.status).toBe(404);

    const forbiddenOrigin = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: "https://blocked.example"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(forbiddenOrigin.status).toBe(403);

    const preflight = await fetch(baseUrl, {
      method: "OPTIONS",
      headers: {
        origin: "https://allowed.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,mcp-protocol-version"
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");

    const malformed = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: "{not-json"
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toContain("application/json");
    const malformedBody = await malformed.text();
    expect(malformedBody).not.toContain("D:\\Helios");
    expect(JSON.parse(malformedBody)).toMatchObject({ error: { code: -32700 } });

    const transport = new StreamableHTTPClientTransport(baseUrl, {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    });
    const client = new Client({ name: "helios-http-test", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(4);
    const result = await client.callTool({
      name: "get_trace_logs",
      arguments: { traceId: "0123456789abcdef0123456789abcdef", lookbackMinutes: 30 }
    });
    expect(result.isError).not.toBe(true);
    await client.close();
  });

  it("publishes RFC 9728 metadata only for OIDC mode", async () => {
    const config: HttpConfig = {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      publicUrl: "http://127.0.0.1:3000/mcp",
      allowedHosts: [],
      allowedOrigins: [],
      preAuthRateLimitRequests: 100,
      preAuthRateLimitWindowMs: 60_000,
      auth: {
        mode: "oidc",
        issuer: "https://issuer.example/",
        audience: "http://127.0.0.1:3000/mcp",
        jwksUri: "https://issuer.example/jwks",
        algorithms: ["RS256"],
        requiredScopes: []
      }
    };
    handle = await startHttpServer(config, () => createServer(), logger);
    const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", handle.url);

    const response = await fetch(metadataUrl);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: config.publicUrl,
      authorization_servers: ["https://issuer.example/"]
    });
    const unauthorized = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("returns HTTP 429 with Retry-After before repeated authentication work", async () => {
    const config: HttpConfig = {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      publicUrl: "http://127.0.0.1:3000/mcp",
      allowedHosts: [],
      allowedOrigins: [],
      preAuthRateLimitRequests: 1,
      preAuthRateLimitWindowMs: 60_000,
      auth: { mode: "static", tokens: { test: token } }
    };
    handle = await startHttpServer(config, () => createServer(), logger);
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    };

    expect((await fetch(handle.url, request)).status).toBe(401);
    const limited = await fetch(handle.url, request);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });
});

function parseTextResult(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("Expected content array");
  }
  const text = result.content.find(
    (item): item is { type: "text"; text: string } =>
      item !== null && typeof item === "object" && "type" in item && item.type === "text" &&
      "text" in item && typeof item.text === "string"
  );
  if (text === undefined) throw new Error("Expected text content");
  return JSON.parse(text.text) as Record<string, unknown>;
}
