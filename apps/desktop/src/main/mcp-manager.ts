import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpSession, type McpConnectInfo } from '@restless/core/mcp';
import type { KeyValue, McpLogEntry, McpServerConfig } from '@restless/core';

const kvToRecord = (list: KeyValue[] | undefined) => Object.fromEntries((list ?? []).filter((k) => k.enabled && k.key).map((k) => [k.key, k.value]));

/** Owns live MCP sessions in the main process. stdio servers are child processes of the app. */
export class McpManager {
  private sessions = new Map<string, McpSession>();
  private counter = 0;

  constructor(private emit: (e: McpLogEntry) => void) {}

  private get(id: string): McpSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error('This MCP session is no longer connected. Connect again.');
    return s;
  }

  async connect(cfg: McpServerConfig): Promise<McpConnectInfo> {
    const sessionId = `${cfg.id}:${++this.counter}`;
    let transport: Transport;
    const stderrTail: string[] = [];
    let session: McpSession | null = null;

    if (cfg.transport === 'stdio') {
      if (!cfg.command) throw new Error('Enter the command that starts the server');
      const stdio = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...getDefaultEnvironment(), PATH: process.env.PATH ?? '', ...kvToRecord(cfg.env) },
        cwd: cfg.cwd || undefined,
        stderr: 'pipe',
      });
      stdio.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
          session?.push('stderr', line);
        }
      });
      transport = stdio;
    } else {
      if (!cfg.url) throw new Error('Enter the server URL');
      let url: URL;
      try {
        url = new URL(cfg.url);
      } catch {
        throw new Error(`Invalid URL: ${cfg.url}`);
      }
      const headers = kvToRecord(cfg.headers);
      transport =
        cfg.transport === 'http'
          ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
          : new SSEClientTransport(url, {
              requestInit: { headers },
              eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) },
            });
    }

    session = new McpSession(sessionId, transport, this.emit, { stdio: cfg.transport === 'stdio' });
    session.push('info', cfg.transport === 'stdio' ? `Starting: ${[cfg.command, ...(cfg.args ?? [])].join(' ')}` : `Connecting to ${cfg.url} (${cfg.transport})`);
    try {
      const info = await session.connect();
      this.sessions.set(sessionId, session);
      return info;
    } catch (e) {
      await session.close();
      let msg = (e as Error).message;
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') msg = `Command not found: ${cfg.command}. Use a full path, or check that it is installed and on your PATH.`;
      if (stderrTail.length) msg += `\n\nLast lines the server wrote to stderr:\n${stderrTail.join('\n')}`;
      throw new Error(msg);
    }
  }

  catalog(id: string) {
    return this.get(id).catalog();
  }
  callTool(id: string, name: string, args: Record<string, unknown>) {
    return this.get(id).callTool(name, args);
  }
  readResource(id: string, uri: string) {
    return this.get(id).readResource(uri);
  }
  getPrompt(id: string, name: string, args: Record<string, string>) {
    return this.get(id).getPrompt(name, args);
  }
  ping(id: string) {
    return this.get(id).ping();
  }
  async disconnect(id: string) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.close();
  }
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }
}
