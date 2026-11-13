/**
 * npm run mcp — the memory ledger as an MCP server over stdio.
 * See README → "Use the memory from Claude Desktop".
 * Nothing may be printed to stdout here: stdout carries the protocol.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { MemoryStore } from './memory/store.js';
import { createMcpServer } from './mcp/server.js';

const server = createMcpServer({
  // Fresh read per call: the chat server may have saved new conversations.
  loadStore: () => new MemoryStore(config.dataFile).load(),
  now: () => new Date(),
  timezone: config.defaultTimezone,
});

await server.connect(new StdioServerTransport());
console.error(`[ledger-memory] MCP server ready (memory: ${config.dataFile})`);
