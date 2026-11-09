// The contract between the shared UI and a shell (desktop, extension, CLI).
// The UI never calls fetch, spawns processes or touches files itself; it goes through a Bridge.
import type { HttpResponse, McpLogEntry, McpServerConfig, ResolvedRequest, Workspace } from './types';
import type { McpCallResult, McpCatalog, McpConnectInfo } from './mcp-session';

export interface BridgeCapabilities {
  /** Can launch local stdio MCP servers (needs a real process). */
  stdio: boolean;
  /** Can send Cookie, Origin, Host and other browser-forbidden headers. */
  forbiddenHeaders: boolean;
  /** Reports DNS / connect / TLS / TTFB timings. */
  detailedTimings: boolean;
  /** Workspace is a folder of plain files that can live in git. */
  fileWorkspace: boolean;
}

export interface Bridge {
  platform: 'desktop' | 'extension' | 'web';
  capabilities: BridgeCapabilities;

  sendHttp(req: ResolvedRequest): Promise<HttpResponse>;
  cancelHttp?(): void;

  mcp: {
    /** Session ids MUST be `${cfg.id}:<anything>` so the UI can group log lines by server before connect resolves. */
    connect(cfg: McpServerConfig): Promise<McpConnectInfo>;
    catalog(sessionId: string): Promise<McpCatalog>;
    callTool(sessionId: string, name: string, args: Record<string, unknown>): Promise<McpCallResult>;
    readResource(sessionId: string, uri: string): Promise<McpCallResult>;
    getPrompt(sessionId: string, name: string, args: Record<string, string>): Promise<McpCallResult>;
    ping(sessionId: string): Promise<number>;
    disconnect(sessionId: string): Promise<void>;
    onLog(cb: (entry: McpLogEntry) => void): () => void;
  };

  storage: {
    load(): Promise<Workspace>;
    save(ws: Workspace): Promise<void>;
    /** Human readable location, e.g. a folder path. */
    location(): Promise<string>;
    /** Desktop only: pick another folder as workspace. */
    chooseFolder?(): Promise<string | null>;
  };

  /** Desktop only: open a file picker and return its text. */
  pickFile?(accept: string[]): Promise<{ name: string; text: string } | null>;
}
