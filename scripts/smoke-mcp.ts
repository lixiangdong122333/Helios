import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNodeServer } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Logging } from "@google-cloud/logging";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface SmokeResult {
  toolCount: number;
  returnedEntries: number;
}

async function main(): Promise<void> {
  const projectId = process.env.HELIOS_SMOKE_PROJECT ?? await new Logging().auth.getProjectId();
  const baseEnvironment = stringEnvironment({
    ...process.env,
    HELIOS_DEFAULT_PROJECTS: projectId,
    HELIOS_LOG_LEVEL: "error"
  });
  const stdio = await smokeStdio(projectId, baseEnvironment);
  const http = await smokeHttp(projectId, baseEnvironment);
  process.stdout.write(`${JSON.stringify({ projectId, stdio, http })}\n`);
}

async function smokeStdio(projectId: string, environment: Record<string, string>): Promise<SmokeResult> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js"), "--transport", "stdio"],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe"
  });
  const client = new Client({ name: "helios-live-stdio-smoke", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await exerciseClient(client, projectId);
  } finally {
    await client.close();
  }
}

async function smokeHttp(projectId: string, environment: Record<string, string>): Promise<SmokeResult> {
  const port = await getFreePort();
  const token = randomBytes(32).toString("hex");
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const child = spawn(process.execPath, [resolve("dist/index.js"), "--transport", "http"], {
    cwd: process.cwd(),
    env: {
      ...environment,
      HELIOS_HTTP_HOST: "127.0.0.1",
      HELIOS_HTTP_PORT: String(port),
      HELIOS_HTTP_PATH: "/mcp",
      HELIOS_HTTP_PUBLIC_URL: endpoint.href,
      HELIOS_HTTP_AUTH_MODE: "static",
      HELIOS_HTTP_STATIC_TOKENS_JSON: JSON.stringify({ smoke: token })
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  const stderr = captureStderr(child);
  try {
    await waitUntilReady(new URL("/readyz", endpoint), child, stderr);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    });
    const client = new Client({ name: "helios-live-http-smoke", version: "1.0.0" });
    await client.connect(transport);
    try {
      return await exerciseClient(client, projectId);
    } finally {
      await client.close();
    }
  } finally {
    await stopChild(child);
  }
}

async function exerciseClient(client: Client, projectId: string): Promise<SmokeResult> {
  const tools = await client.listTools();
  const result = await client.callTool({
    name: "query_logs",
    arguments: {
      projectIds: [projectId],
      lookbackMinutes: 5,
      limit: 1,
      includePayload: false
    }
  });
  if ("isError" in result && result.isError === true) {
    throw new Error(`Helios query_logs failed: ${textResult(result)}`);
  }
  const body = JSON.parse(textResult(result)) as { metadata?: { returnedEntries?: unknown } };
  const returnedEntries = body.metadata?.returnedEntries;
  if (typeof returnedEntries !== "number") {
    throw new Error("Helios query_logs did not return numeric metadata.returnedEntries.");
  }
  return { toolCount: tools.tools.length, returnedEntries };
}

function textResult(result: unknown): string {
  if (result === null || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("MCP result has no content array.");
  }
  const content = result.content.find(
    (item): item is { type: "text"; text: string } =>
      item !== null && typeof item === "object" && "type" in item && item.type === "text" &&
      "text" in item && typeof item.text === "string"
  );
  if (content === undefined) throw new Error("MCP result has no text content.");
  return content.text;
}

async function getFreePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not allocate a local TCP port.");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close(error => error === undefined ? resolveClose() : reject(error))
  );
  return port;
}

function captureStderr(child: ChildProcess): () => string {
  let output = "";
  child.stderr?.on("data", chunk => {
    output = `${output}${String(chunk)}`.slice(-8_192);
  });
  return () => output.trim();
}

async function waitUntilReady(url: URL, child: ChildProcess, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Helios HTTP smoke server exited early: ${stderr()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The listener may not be bound yet.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Helios HTTP smoke server did not become ready: ${stderr()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>(resolveExit => child.once("exit", () => resolveExit())),
    new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 5_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    message: error instanceof Error ? error.message : String(error)
  })}\n`);
  process.exitCode = 1;
});
