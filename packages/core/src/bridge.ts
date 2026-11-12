// The contract between the shared UI and a shell (desktop, extension, CLI).
// The UI never calls fetch, spawns processes or touches files itself; it goes through a Bridge.
import type { FileRef, HttpResponse, McpLogEntry, McpServerConfig, ResolvedRequest, Workspace } from './types';
import type { McpCallResult, McpCatalog, McpConnectInfo } from './mcp-session';
import type { CapturedEntry, CaptureSession } from './capture';

export interface CaptureBrowserStatus {
  /** The Restless browser window is open. */
  open: boolean;
  /** The capture it is recording into. */
  sessionId: string | null;
  url: string;
  paused: boolean;
}

/** Network capture: captures (sessions) and their requests; on desktop, a browser that records them. */
export interface CaptureBridge {
  listSessions(): Promise<CaptureSession[]>;
  getEntries(sessionId: string): Promise<CapturedEntry[]>;
  deleteSession(id: string): Promise<void>;
  /** Store a whole session, e.g. an imported HAR file. */
  importSession(session: CaptureSession, entries: CapturedEntry[]): Promise<void>;
  /** Called whenever sessions, entries or the browser change (live recording). */
  onChange(cb: (sessionId: string | null) => void): () => void;
  /** The app is asked to show a capture (the browser's "Show in Restless"). */
  onReveal?(cb: (sessionId: string) => void): () => void;

  /** Desktop: a built-in browser window that records every request its pages make. */
  browser?: {
    /** Open (or focus) the browser, optionally at a URL. Resolves to the capture it records into. */
    open(url?: string): Promise<string>;
    status(): Promise<CaptureBrowserStatus>;
    setPaused(paused: boolean): Promise<void>;
    /** Finish the current capture and start a new one (the browser stays open). */
    newCapture(): Promise<string>;
    /** Sign out everywhere in the Restless browser: clears its cookies, storage and cache. */
    clearData(): Promise<void>;
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

  /** Desktop only: choose a file to upload with a request. Only its path is kept; it is read when the request is sent. */
  pickUpload?(): Promise<FileRef | null>;

  /**
   * Desktop only: show a sign-in page in its own window and resolve to the address it finally sends the browser
   * to, once that address starts with `redirectUri`. Rejects when the window is closed first.
   */
  authorize?(url: string, redirectUri: string): Promise<string>;

  /** Network capture (desktop: the Restless browser; everywhere: HAR files). */
  capture?: CaptureBridge;

  /** Desktop: ask where to save a file and write it. Returns the saved path, or null if cancelled. Without it the UI downloads the file. */
  saveFile?(suggestedName: string, text: string): Promise<string | null>;
}
