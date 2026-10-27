import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../mcp/server.ts';
import type { CommandFn } from './types.ts';

// stdout belongs to the MCP protocol: nothing else may print there.
const cmd: CommandFn = async () => {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  // Serve until the client closes stdin, then exit cleanly.
  return new Promise(() => { process.stdin.on('end', () => process.exit(0)); });
};
export default cmd;
