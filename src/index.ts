#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDnsTools } from "./tools/dns.js";

if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error("Missing required environment variable: CLOUDFLARE_API_TOKEN");
  process.exit(1);
}

const server = new McpServer({
  name: "mcp-cloudflare",
  version: "1.1.0",
});

registerDnsTools(server);

await server.connect(new StdioServerTransport());
