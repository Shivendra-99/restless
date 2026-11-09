// Transport-agnostic MCP session. Shells create the transport (stdio needs Node, HTTP works
// everywhere) and hand it here; this class logs every JSON-RPC frame and wraps the SDK client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import type { McpLogDirection, McpLogEntry } from './types';

export const CLIENT_INFO = { name: 'restless', version: '0.4.0' };

export interface McpConnectInfo {
  sessionId: string;
  serverInfo: { name: string; version: string; title?: string } | null;
  capabilities: Record<string, unknown>;
  instructions: string | null;
  protocolVersion: string | null;
  connectMs: number;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCatalog {
  tools: McpTool[];
  resources: { uri: string; name: string; description?: string; mimeType?: string }[];
  resourceTemplates: { uriTemplate: string; name: string; description?: string }[];
  prompts: { name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }[];
  errors: string[];
}

export interface McpCallResult {
  result: unknown;
  durationMs: number;
  isError: boolean;
}

type LogFn = (entry: McpLogEntry) => void;

function describe(msg: JSONRPCMessage): { method?: string; rpcId?: string | number } {
  const m = msg as { method?: string; id?: string | number };
  return { method: m.method, rpcId: m.id };
}

/** Heuristic for the #1 stdio bug: the server prints logs to stdout and corrupts the JSON-RPC stream. */
export function looksLikeStdoutPollution(err: Error): boolean {
  const s = `${err.name} ${err.message}`;
  return /SyntaxError|Unexpected token|not valid JSON|JSON\.parse|invalid_union|ZodError/i.test(s);
}

class LoggingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  negotiatedVersion: string | null = null;

  constructor(private inner: Transport, private emit: (d: McpLogDirection, m: unknown, meta?: { method?: string; rpcId?: string | number }) => void, private isStdio: boolean) {
    inner.onmessage = (message, extra) => {
      const r = (message as { result?: { protocolVersion?: string } }).result;
      if (r && typeof r.protocolVersion === 'string') this.negotiatedVersion = r.protocolVersion;
      this.emit('in', message, describe(message));
      this.onmessage?.(message, extra);
    };
    inner.onerror = (error) => {
      let text = error.message;
      if (this.isStdio && looksLikeStdoutPollution(error)) {
        text += '\nHint: the server wrote something that is not JSON-RPC to stdout. In stdio servers send logs to stderr (console.error), never console.log.';
      }
      this.emit('error', text);
      this.onerror?.(error);
    };
    inner.onclose = () => {
      this.emit('info', 'Connection closed');
      this.onclose?.();
    };
  }

  get sessionId() {
    return this.inner.sessionId;
  }

  setProtocolVersion = (version: string) => {
    this.inner.setProtocolVersion?.(version);
  };

  start() {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions) {
    this.emit('out', message, describe(message));
    return this.inner.send(message, options);
  }

  close() {
    return this.inner.close();
  }
}

export class McpSession {
  readonly client: Client;
  private transport: LoggingTransport;
  private closed = false;

  /**
   * @param opts.validator JSON Schema validator for tool output schemas. The SDK default (Ajv) compiles
   * schemas with `new Function`, which browser extensions forbid; the extension passes an eval-free one.
   */
  constructor(readonly id: string, inner: Transport, private log: LogFn, opts: { stdio?: boolean; validator?: jsonSchemaValidator } = {}) {
    this.transport = new LoggingTransport(inner, (direction, message, meta) => this.push(direction, message, meta), !!opts.stdio);
    this.client = new Client(CLIENT_INFO, { capabilities: {}, ...(opts.validator ? { jsonSchemaValidator: opts.validator } : {}) });
  }

  push(direction: McpLogDirection, message: unknown, meta: { method?: string; rpcId?: string | number } = {}) {
    this.log({ sessionId: this.id, ts: Date.now(), direction, message, ...meta });
  }

  async connect(timeoutMs = 30_000): Promise<McpConnectInfo> {
    const started = performance.now();
    await this.client.connect(this.transport, { timeout: timeoutMs });
    const info = this.client.getServerVersion();
    return {
      sessionId: this.id,
      serverInfo: info ? { name: info.name, version: info.version, title: (info as { title?: string }).title } : null,
      capabilities: (this.client.getServerCapabilities() ?? {}) as Record<string, unknown>,
      instructions: this.client.getInstructions() ?? null,
      protocolVersion: this.transport.negotiatedVersion,
      connectMs: Math.round(performance.now() - started),
    };
  }

  async catalog(): Promise<McpCatalog> {
    const caps = this.client.getServerCapabilities() ?? {};
    const out: McpCatalog = { tools: [], resources: [], resourceTemplates: [], prompts: [], errors: [] };
    const paged = async <T>(label: string, fn: (cursor?: string) => Promise<{ nextCursor?: string } & Record<string, unknown>>, key: string, into: T[]) => {
      try {
        let cursor: string | undefined;
        let guard = 0;
        do {
          const page = await fn(cursor);
          into.push(...((page[key] as T[]) ?? []));
          cursor = page.nextCursor;
        } while (cursor && ++guard < 100);
      } catch (e) {
        out.errors.push(`${label}: ${(e as Error).message}`);
      }
    };
    if (caps.tools) await paged('tools/list', (cursor) => this.client.listTools({ cursor }), 'tools', out.tools as McpTool[]);
    if (caps.resources) {
      await paged('resources/list', (cursor) => this.client.listResources({ cursor }), 'resources', out.resources);
      await paged('resources/templates/list', (cursor) => this.client.listResourceTemplates({ cursor }), 'resourceTemplates', out.resourceTemplates);
    }
    if (caps.prompts) await paged('prompts/list', (cursor) => this.client.listPrompts({ cursor }), 'prompts', out.prompts);
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<McpCallResult> {
    const t0 = performance.now();
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    return { result, durationMs: Math.round(performance.now() - t0), isError: !!(result as { isError?: boolean }).isError };
  }

  async readResource(uri: string): Promise<McpCallResult> {
    const t0 = performance.now();
    const result = await this.client.readResource({ uri });
    return { result, durationMs: Math.round(performance.now() - t0), isError: false };
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<McpCallResult> {
    const t0 = performance.now();
    const result = await this.client.getPrompt({ name, arguments: args });
    return { result, durationMs: Math.round(performance.now() - t0), isError: false };
  }

  async ping(): Promise<number> {
    const t0 = performance.now();
    await this.client.ping();
    return Math.round(performance.now() - t0);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      /* already gone */
    }
  }
}
