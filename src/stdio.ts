// Local entry point for Claude Code and other stdio MCP clients. No OAuth:
// whoever can run this process can already read the data directory.
// Nothing may write to stdout except the transport.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.ts";

await createServer().connect(new StdioServerTransport());
