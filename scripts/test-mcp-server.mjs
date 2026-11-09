#!/usr/bin/env node
// Demo MCP server for trying Probe.
//   stdio:            node scripts/test-mcp-server.mjs
//   stdio, buggy:     node scripts/test-mcp-server.mjs --pollute   (logs to stdout, the classic bug)
//   Streamable HTTP:  node scripts/test-mcp-server.mjs --http 3333  -> http://localhost:3333/mcp
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const pollute = process.argv.includes('--pollute');
const httpIdx = process.argv.indexOf('--http');
const httpPort = httpIdx >= 0 ? Number(process.argv[httpIdx + 1] || 3333) : null;

function buildServer() {
  const server = new McpServer(
    { name: 'probe-demo-server', version: '1.0.0' },
    { instructions: 'Demo server with a few tools, one resource and one prompt.' },
  );

  server.registerTool(
    'echo',
    { title: 'Echo', description: 'Returns the given text back unchanged. Useful to test connectivity.', inputSchema: { text: z.string().describe('Text to echo back') } },
    async ({ text }) => {
      if (pollute) console.log('DEBUG: echo called with', text); // corrupts the stdio stream on purpose
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'add',
    { description: 'Adds two numbers and returns the sum as structured output.', inputSchema: { a: z.number().describe('First number'), b: z.number().describe('Second number') }, outputSchema: { sum: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }], structuredContent: { sum: a + b } }),
  );

  server.registerTool(
    'get_weather',
    { description: 'Weather', inputSchema: { city: z.string(), units: z.enum(['metric', 'imperial']).optional() } },
    async ({ city, units = 'metric' }) => ({ content: [{ type: 'text', text: `${city}: 31°${units === 'metric' ? 'C' : 'F'}, haze` }] }),
  );

  server.registerTool(
    'slow',
    { description: 'Waits the given number of milliseconds, then answers. For timeout testing.', inputSchema: { ms: z.number().int().min(0).max(60000).describe('Delay in milliseconds') } },
    async ({ ms }) => {
      await new Promise((r) => setTimeout(r, ms));
      return { content: [{ type: 'text', text: `done after ${ms}ms` }] };
    },
  );

  server.registerTool(
    'fail',
    { description: 'Always returns a tool error (isError: true) so you can test error handling.', inputSchema: {} },
    async () => ({ isError: true, content: [{ type: 'text', text: 'Something went wrong on purpose' }] }),
  );

  server.registerResource(
    'welcome',
    'notes://welcome',
    { title: 'Welcome note', description: 'A static text resource', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, text: 'Hello from the demo server resource!' }] }),
  );

  server.registerResource(
    'user-profile',
    new ResourceTemplate('users://{id}/profile', { list: undefined }),
    { description: 'Profile for a user id' },
    async (uri, { id }) => ({ contents: [{ uri: uri.href, text: JSON.stringify({ id, name: `User ${id}` }) }] }),
  );

  server.registerPrompt(
    'review_code',
    { description: 'Ask the model to review a code snippet', argsSchema: { code: z.string().describe('Code to review') } },
    ({ code }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Please review this code:\n\n${code}` } }] }),
  );
  return server;
}

if (httpPort) {
  const transports = new Map();
  const srv = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      transport.onclose = () => transport.sessionId && transports.delete(transport.sessionId);
      await buildServer().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  srv.listen(httpPort, () => console.error(`MCP demo server on http://localhost:${httpPort}/mcp`));
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error('MCP demo server running on stdio' + (pollute ? ' (polluting stdout!)' : ''));
}
