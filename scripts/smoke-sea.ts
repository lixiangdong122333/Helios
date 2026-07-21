import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createNodeServer } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const executable = process.argv[2];
if (executable === undefined) {
  throw new Error("Usage: npm run smoke:sea -- <path-to-sea-executable>");
}

const executablePath = resolve(executable);
const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
) as { version?: unknown };
if (typeof packageMetadata.version !== "string") {
  throw new Error("package.json does not contain a valid version.");
}

smokeHelp(executablePath);
const missingAdcPath = resolve(
  process.cwd(),
  `.helios-sea-smoke-missing-adc-${randomBytes(8).toString("hex")}.json`
);
const environment = stringEnvironment({
  ...process.env,
  HELIOS_DEFAULT_PROJECTS: "helios-sea-smoke",
  HELIOS_LOG_LEVEL: "error",
  GOOGLE_APPLICATION_CREDENTIALS: missingAdcPath
});
const stdio = await smokeStdio(executablePath, environment, packageMetadata.version, missingAdcPath);
const http = await smokeHttp(executablePath, environment, packageMetadata.version);

process.stdout.write(`${JSON.stringify({ executable: executablePath, stdio, http })}\n`);

function smokeHelp(path: string): void {
  const result = spawnSync(path, ["--help"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 || !result.stdout.includes("Usage:")) {
    throw new Error(`SEA --help failed with exit code ${String(result.status)}: ${result.stderr}`);
  }
}

async function smokeStdio(
  path: string,
  environment: Record<string, string>,
  expectedVersion: string,
  missingAdcPath: string
): Promise<{ toolCount: number; version: string; googleClientError: string }> {
  const transport = new StdioClientTransport({
    command: path,
    args: ["--transport", "stdio"],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe"
  });
  const client = new Client({ name: "helios-sea-smoke-stdio", version: "1.0.0" });
  await client.connect(transport);
  try {
    const server = await assertServer(client, expectedVersion);
    const googleClientError = await assertGoogleClientPath(client, missingAdcPath);
    return { ...server, googleClientError };
  } finally {
    await client.close();
  }
}

async function smokeHttp(
  path: string,
  environment: Record<string, string>,
  expectedVersion: string
): Promise<{ toolCount: number; version: string; health: string; readiness: string }> {
  const port = await getFreePort();
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const token = randomBytes(32).toString("hex");
  const child = spawn(path, ["--transport", "http"], {
    cwd: process.cwd(),
    env: {
      ...environment,
      HELIOS_HTTP_HOST: "127.0.0.1",
      HELIOS_HTTP_PORT: String(port),
      HELIOS_HTTP_PATH: "/mcp",
      HELIOS_HTTP_PUBLIC_URL: endpoint.href,
      HELIOS_HTTP_AUTH_MODE: "static",
      HELIOS_HTTP_STATIC_TOKENS_JSON: JSON.stringify({ seaSmoke: token })
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  const stderr = captureStderr(child);
  try {
    const health = await getStatus(new URL("/healthz", endpoint), child, stderr);
    if (health !== "ok") throw new Error(`Unexpected SEA health status: ${health}`);
    const readiness = await getStatus(new URL("/readyz", endpoint), child, stderr);
    if (readiness !== "ready") throw new Error(`Unexpected SEA readiness status: ${readiness}`);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    });
    const client = new Client({ name: "helios-sea-smoke-http", version: "1.0.0" });
    await client.connect(transport);
    try {
      return { ...(await assertServer(client, expectedVersion)), health, readiness };
    } finally {
      await client.close();
    }
  } finally {
    await stopChild(child);
  }
}

async function assertServer(client: Client, expectedVersion: string): Promise<{ toolCount: number; version: string }> {
  const server = client.getServerVersion();
  if (server?.name !== "helios-cloud-logging" || server.version !== expectedVersion) {
    throw new Error(`Unexpected SEA server identity: ${JSON.stringify(server)}`);
  }
  const tools = await client.listTools();
  const expectedTools = ["aggregate_exceptions", "get_trace_logs", "query_logs", "summarize_logs"];
  const actualTools = tools.tools.map(tool => tool.name).sort();
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected SEA tool list: ${JSON.stringify(actualTools)}`);
  }
  return {
    toolCount: actualTools.length,
    version: server.version
  };
}

async function assertGoogleClientPath(client: Client, missingAdcPath: string): Promise<string> {
  const result = await client.callTool({
    name: "query_logs",
    arguments: {
      projectIds: ["helios-sea-smoke"],
      lookbackMinutes: 1,
      limit: 1,
      includePayload: false
    }
  });
  const structured = result.structuredContent;
  const errorCode = structured !== null && typeof structured === "object" && "error" in structured &&
    structured.error !== null && typeof structured.error === "object" && "code" in structured.error &&
    typeof structured.error.code === "string"
    ? structured.error.code
    : undefined;
  const errorMessage = structured !== null && typeof structured === "object" && "error" in structured &&
    structured.error !== null && typeof structured.error === "object" && "message" in structured.error &&
    typeof structured.error.message === "string"
    ? structured.error.message
    : undefined;
  if (
    result.isError !== true ||
    errorCode !== "UPSTREAM_ERROR" ||
    errorMessage?.includes(missingAdcPath) !== true
  ) {
    throw new Error(`SEA Google client path returned an unexpected result: ${JSON.stringify(result)}`);
  }
  return errorCode;
}

async function getStatus(url: URL, child: ChildProcess, stderr: () => string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`SEA HTTP process exited early: ${stderr()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const body = await response.json() as { status?: unknown };
        if (typeof body.status !== "string") throw new Error(`Invalid health response from ${url}.`);
        return body.status;
      }
    } catch {
      // The listener may not be bound yet.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`SEA HTTP process did not become ready: ${stderr()}`);
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
