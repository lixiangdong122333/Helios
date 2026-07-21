import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export async function startStdioServer(server: McpServer): Promise<{ close(): Promise<void> }> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    async close(): Promise<void> {
      await server.close();
    }
  };
}
