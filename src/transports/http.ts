import type { Server as NodeHttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import type { HttpConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createTokenVerifier, protectedResourceMetadata, requiredScopes } from "../auth/token-verifier.js";

export type McpServerFactory = () => McpServer;

export interface HttpServerHandle {
  app: ReturnType<typeof createMcpExpressApp>;
  server: NodeHttpServer;
  url: string;
  close(): Promise<void>;
}

export function createHttpApp(config: HttpConfig, serverFactory: McpServerFactory, logger: Logger) {
  const app = createMcpExpressApp({
    host: config.host,
    ...(config.allowedHosts.length === 0 ? {} : { allowedHosts: config.allowedHosts })
  });
  app.disable("x-powered-by");
  app.use(corsPolicy(config.allowedOrigins));
  app.use(
    config.path,
    fixedWindowHttpRateLimit(config.preAuthRateLimitRequests, config.preAuthRateLimitWindowMs)
  );

  const resourceMetadataUrl = config.auth.mode === "oidc"
    ? getOAuthProtectedResourceMetadataUrl(new URL(config.publicUrl))
    : undefined;
  const verifier = createTokenVerifier(config.auth, config.publicUrl);
  const authMiddleware = requireBearerAuth({
    verifier,
    requiredScopes: requiredScopes(config.auth),
    ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl })
  });

  app.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));
  app.get("/readyz", (_request, response) => response.status(200).json({ status: "ready" }));
  if (resourceMetadataUrl !== undefined) {
    app.get(new URL(resourceMetadataUrl).pathname, (_request, response) =>
      response.status(200).json(protectedResourceMetadata(config.auth, config.publicUrl))
    );
  }
  app.post(config.path, authMiddleware, async (request: Request, response: Response) => {
    const mcpServer = serverFactory();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true
    });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.error("http_mcp_request_failed", {
        error: error instanceof Error ? error.message : String(error),
        headersSent: response.headersSent
      });
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
    }
  });

  const methodNotAllowed = (_request: Request, response: Response): void => {
    response.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null
    });
  };
  app.get(config.path, authMiddleware, methodNotAllowed);
  app.delete(config.path, authMiddleware, methodNotAllowed);
  app.use(jsonErrorHandler(config.allowedOrigins, logger));
  return app;
}

export async function startHttpServer(
  config: HttpConfig,
  serverFactory: McpServerFactory,
  logger: Logger
): Promise<HttpServerHandle> {
  const app = createHttpApp(config, serverFactory, logger);
  const server = await new Promise<NodeHttpServer>((resolve, reject) => {
    const listeningServer = app.listen(config.port, config.host, () => resolve(listeningServer));
    listeningServer.once("error", reject);
  });
  const address = server.address();
  const actualPort = address !== null && typeof address === "object" ? address.port : config.port;
  const localHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  const urlHost = localHost.includes(":") && !localHost.startsWith("[") ? `[${localHost}]` : localHost;
  return {
    app,
    server,
    url: `http://${urlHost}:${actualPort}${config.path}`,
    close: () => closeHttpServer(server)
  };
}

function corsPolicy(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.get("origin");
    if (origin !== undefined) {
      if (!allowed.has(origin)) {
        response.status(403).json({ error: "Origin is not allowed." });
        return;
      }
      setCorsHeaders(response, origin);
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
    } else {
      next();
    }
  };
}

function setCorsHeaders(response: Response, origin: string): void {
  response.vary("Origin");
  response.set("Access-Control-Allow-Origin", origin);
  response.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.set(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,MCP-Protocol-Version,MCP-Session-Id,Last-Event-ID"
  );
  response.set("Access-Control-Expose-Headers", "MCP-Session-Id,WWW-Authenticate");
}

function fixedWindowHttpRateLimit(requestsPerWindow: number, windowMs: number) {
  const buckets = new Map<string, { count: number; startedAt: number }>();
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.method === "OPTIONS") {
      next();
      return;
    }
    const now = Date.now();
    const key = request.socket.remoteAddress ?? "unknown";
    let bucket = buckets.get(key);
    if (bucket === undefined || now - bucket.startedAt >= windowMs) {
      bucket = { count: 0, startedAt: now };
      buckets.set(key, bucket);
    }
    if (bucket.count >= requestsPerWindow) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1_000));
      response.set("Retry-After", String(retryAfterSeconds));
      response.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Too many requests" },
        id: null
      });
      return;
    }
    bucket.count += 1;
    if (buckets.size > 10_000) {
      for (const [bucketKey, candidate] of buckets) {
        if (now - candidate.startedAt >= windowMs) buckets.delete(bucketKey);
      }
      while (buckets.size > 10_000) {
        const oldestKey = buckets.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        buckets.delete(oldestKey);
      }
    }
    next();
  };
}

function jsonErrorHandler(allowedOrigins: string[], logger: Logger): ErrorRequestHandler {
  const allowed = new Set(allowedOrigins);
  return (error: unknown, request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const origin = request.get("origin");
    if (origin !== undefined && allowed.has(origin)) {
      setCorsHeaders(response, origin);
    }
    const status = getHttpErrorStatus(error);
    logger.warn("http_request_rejected", { status, errorType: getHttpErrorType(error) });
    response.status(status).json({
      jsonrpc: "2.0",
      error: {
        code: status === 413 ? -32001 : -32700,
        message: status === 413 ? "Request body is too large" : "Invalid JSON request body"
      },
      id: null
    });
  };
}

function getHttpErrorStatus(error: unknown): number {
  if (error !== null && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status === 413 ? 413 : 400;
  }
  return 400;
}

function getHttpErrorType(error: unknown): string {
  if (error !== null && typeof error === "object" && "type" in error && typeof error.type === "string") {
    return error.type;
  }
  return error instanceof Error ? error.name : "unknown";
}

function closeHttpServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const forceCloseTimer = setTimeout(() => server.closeAllConnections(), 10_000);
    forceCloseTimer.unref();
    server.close(error => {
      clearTimeout(forceCloseTimer);
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}
