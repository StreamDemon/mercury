import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MercuryApiClient } from "./client.js";
import { readConfigFromEnv, type MercuryMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createMercuryMcpServer(config: MercuryMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "mercury",
    version: "0.1.0",
  });

  const client = new MercuryApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: MercuryMcpConfig = readConfigFromEnv()) {
  const { server } = createMercuryMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
