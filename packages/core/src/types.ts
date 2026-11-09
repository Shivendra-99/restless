// Shared data model. Everything here is plain JSON so it can live in files (desktop),
// chrome.storage (extension) or be passed over Electron IPC unchanged.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

export type BodyMode = 'none' | 'json' | 'text' | 'form-urlencoded';

export interface RequestBody {
  mode: BodyMode;
  text: string;
  form: KeyValue[];
}

export type Auth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' };

export interface RequestItem {
  id: string;
  name: string;
  /** Folder path inside the workspace, e.g. "users/admin". Empty = root. */
  folder: string;
  method: HttpMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: Auth;
  updatedAt?: number;
}

export interface EnvVar {
  key: string;
  value: string;
  enabled: boolean;
  /** Secret values never go into workspace files; shells store them in an OS-protected store. */
  secret?: boolean;
}

export interface Environment {
  id: string;
  name: string;
  variables: EnvVar[];
}

/** A request after variables, params and auth are applied. This is what an engine sends. */
export interface ResolvedRequest {
  method: HttpMethod;
  url: string;
  headers: [string, string][];
  body?: string;
  timeoutMs?: number;
  followRedirects?: boolean;
}

export interface HttpTimings {
  dns?: number;
  connect?: number;
  tls?: number;
  ttfb?: number;
  download?: number;
  total: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  size: number;
  timings: HttpTimings;
  url: string;
  /** Network level failure (DNS, refused, timeout). status is 0 when set. */
  error?: string;
  /** Headers the engine could not send (browser forbidden headers in the extension). */
  droppedHeaders?: string[];
}

export interface HistoryEntry {
  id: string;
  at: number;
  method: HttpMethod;
  url: string;
  status: number;
  durationMs: number;
  requestId?: string;
}

export type McpTransportKind = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  env?: KeyValue[];
  cwd?: string;
  url?: string;
  headers?: KeyValue[];
}

export type McpLogDirection = 'out' | 'in' | 'stderr' | 'error' | 'info';

export interface McpLogEntry {
  sessionId: string;
  ts: number;
  direction: McpLogDirection;
  /** JSON-RPC message for in/out, text for the rest. */
  message: unknown;
  method?: string;
  rpcId?: string | number;
}

export interface Workspace {
  name: string;
  requests: RequestItem[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  mcpServers: McpServerConfig[];
  history: HistoryEntry[];
}

export function emptyWorkspace(name = 'My workspace'): Workspace {
  return { name, requests: [], environments: [], activeEnvironmentId: null, mcpServers: [], history: [] };
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function newRequest(partial: Partial<RequestItem> = {}): RequestItem {
  return {
    id: newId(),
    name: 'New request',
    folder: '',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { mode: 'none', text: '', form: [] },
    auth: { type: 'none' },
    ...partial,
  };
}
