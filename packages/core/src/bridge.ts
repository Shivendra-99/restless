// The contract between the shared UI and a shell (desktop, extension, CLI).
// The UI never calls fetch, spawns processes or touches files itself; it goes through a Bridge.
import type { HttpResponse, McpLogEntry, McpServerConfig, ResolvedRequest, Workspace } from './types';
import type { McpCallResult, McpCatalog, McpConnectInfo } from './mcp-session';
import type { CapturedEntry, CaptureSession } from './capture';

export interface CaptureTab {
  id: number;
  title: string;
  url: string;
}

export interface RecordingInfo {
  tabId: number;
  sessionId: string;
  title: string;
}

export interface RewindStatus {
  enabled: boolean;
  /** Requests currently held in the buffer. */
  buffered: number;
  minutes: number;
}

export interface DesktopLinkStatus {
  connected: boolean;
  /** Last send failed (desktop app closed?). */
  reachable: boolean;
  port?: number;
}

export interface PairedBrowser {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt?: number;
}

/**
 * Network capture. Every shell can list and show sessions; the extension can record tabs and keep a
 * rewind buffer; the desktop app receives sessions from a paired extension.
 */
export interface CaptureBridge {
  listSessions(): Promise<CaptureSession[]>;
  getEntries(sessionId: string): Promise<CapturedEntry[]>;
  deleteSession(id: string): Promise<void>;
  /** Store a whole session, e.g. an imported HAR file. */
  importSession(session: CaptureSession, entries: CapturedEntry[]): Promise<void>;
  /** Called whenever sessions or entries change (live recording). */
  onChange(cb: (sessionId: string | null) => void): () => void;

  // Extension only
  /** Ask the browser for what recording needs (call it straight from a click). Resolves to whether it was granted. */
  ensureRecordAccess?(): Promise<boolean>;
  listTabs?(): Promise<CaptureTab[]>;
  startRecording?(tabId: number, opts: { apiOnly: boolean }): Promise<string>;
  stopRecording?(tabId: number): Promise<void>;
  recordings?(): Promise<RecordingInfo[]>;
  rewindStatus?(): Promise<RewindStatus>;
  /** Turning it on asks the browser for access to all sites. Resolves to the new state. */
  setRewind?(on: boolean): Promise<boolean>;
  /** Turns the last few minutes into a session. Null when the buffer is empty. */
  grabRewind?(tabId?: number): Promise<string | null>;
  desktop?: {
    status(): Promise<DesktopLinkStatus>;
    connect(code: string): Promise<void>;
    disconnect(): Promise<void>;
    /** Send an existing session again (e.g. it was captured while the desktop app was closed). */
    resend(sessionId: string): Promise<void>;
  };

  // Desktop only
  pairing?: {
    newCode(): Promise<{ code: string; expiresAt: number; port: number }>;
    browsers(): Promise<PairedBrowser[]>;
    remove(id: string): Promise<void>;
  };
}

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

  /** Network capture (record a tab, rewind, sessions). */
  capture?: CaptureBridge;

  /** Desktop: ask where to save a file and write it. Returns the saved path, or null if cancelled. Without it the UI downloads the file. */
  saveFile?(suggestedName: string, text: string): Promise<string | null>;
}
