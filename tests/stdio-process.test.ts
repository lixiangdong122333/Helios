import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("STDIO process transport", () => {
  it("starts the real TypeScript entrypoint and keeps stdout protocol-clean", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("src/index.ts"),
        "--transport",
        "stdio"
      ],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HELIOS_DEFAULT_PROJECTS: "test-project",
        HELIOS_LOG_LEVEL: "error"
      },
      stderr: "pipe"
    });
    const client = new Client({ name: "helios-stdio-test", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      "aggregate_exceptions",
      "get_trace_logs",
      "query_logs",
      "summarize_logs"
    ]);
    await client.close();
  });
});
