// Shared data model. Everything here is plain JSON so it can live in files (desktop),
// chrome.storage (extension) or be passed over Electron IPC unchanged.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

/** A file to upload. Desktop keeps its path; the extension keeps the picked file in memory under `id`. */
export interface FileRef {
  id: string;
  name: string;
  /** Desktop only: where the file is on this computer. Read again on every send. */
  path?: string;
  size?: number;
  contentType?: string;
}

/** One multipart form field: text, or a file when `file` is set. */
export interface FormField extends KeyValue {
  file?: FileRef | null;
}

export type BodyMode = 'none' | 'json' | 'text' | 'form-urlencoded' | 'multipart' | 'file';

export interface RequestBody {
  mode: BodyMode;
  text: string;
  form: KeyValue[];
  /** Fields for mode 'multipart' (multipart/form-data). */
  multipart?: FormField[];
  /** The file sent as the whole body in mode 'file'. */
  file?: FileRef | null;
}

export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384';
export type OAuth2Grant = 'client_credentials' | 'password' | 'authorization_code';

export type Auth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' }
  /** A JWT signed on every send and sent as `Authorization: <prefix> <jwt>`. */
  | { type: 'jwt'; algorithm: JwtAlgorithm; secret: string; secretBase64: boolean; payload: string; prefix: string }
  /** Answers the server's 401 challenge (RFC 7616): the request is sent twice. */
  | { type: 'digest'; username: string; password: string }
  | { type: 'oauth1'; consumerKey: string; consumerSecret: string; token: string; tokenSecret: string; signatureMethod: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT'; realm: string }
  | {
      type: 'oauth2';
      grant: OAuth2Grant;
      tokenUrl: string;
      /** Authorization code grant only. */
      authUrl: string;
      redirectUri: string;
      clientId: string;
      clientSecret: string;
      scope: string;
      /** Password grant only. */
      username: string;
      password: string;
      /** Where the client id and secret go when asking for a token. */
      clientAuth: 'basic' | 'body';
      /** The access token in use: a {{variable}} that "Get new access token" fills (so the token stays out of the workspace files), or a pasted token. */
      token: string;
      prefix: string;
      /** When the token stops working (ms since 1970), if the server said. */
      expiresAt?: number;
    }
  | { type: 'hawk'; id: string; key: string; algorithm: 'sha256' | 'sha1'; ext: string }
  | { type: 'aws'; accessKey: string; secretKey: string; region: string; service: string; sessionToken: string };

export const AUTH_LABELS: Record<Auth['type'], string> = {
  none: 'No auth',
  apikey: 'API key',
  bearer: 'Bearer token',
  jwt: 'JWT bearer',
  basic: 'Basic auth',
  digest: 'Digest auth',
  oauth1: 'OAuth 1.0',
  oauth2: 'OAuth 2.0',
  hawk: 'Hawk',
  aws: 'AWS Signature',
};

/** A fresh auth of the given type with sensible defaults. */
export function newAuth(type: Auth['type']): Auth {
  switch (type) {
    case 'bearer': return { type, token: '' };
    case 'basic': return { type, username: '', password: '' };
    case 'apikey': return { type, key: 'X-API-Key', value: '', in: 'header' };
    case 'jwt': return { type, algorithm: 'HS256', secret: '', secretBase64: false, payload: '{\n  "sub": "user-1",\n  "iat": {{$timestamp}}\n}', prefix: 'Bearer' };
    case 'digest': return { type, username: '', password: '' };
    case 'oauth1': return { type, consumerKey: '', consumerSecret: '', token: '', tokenSecret: '', signatureMethod: 'HMAC-SHA1', realm: '' };
    case 'oauth2':
      return { type, grant: 'client_credentials', tokenUrl: '', authUrl: '', redirectUri: 'http://localhost/callback', clientId: '', clientSecret: '', scope: '', username: '', password: '', clientAuth: 'basic', token: '{{oauth_token}}', prefix: 'Bearer' };
    case 'hawk': return { type, id: '', key: '', algorithm: 'sha256', ext: '' };
    case 'aws': return { type, accessKey: '', secretKey: '', region: 'us-east-1', service: '', sessionToken: '' };
    default: return { type: 'none' };
  }
}

/** After a request is sent, copy a value from its response into a global variable. */
export interface Capture {
  id: string;
  /** Global variable name, used as {{variable}} anywhere. */
  variable: string;
  from: 'body' | 'header';
  /** For body: a JSON path like `access_token`, `data.token` or `items[0].id` ('' = whole body). For header: the header name. */
  path: string;
}

export interface Collection {
  id: string;
  name: string;
  /** Folder paths inside the collection, e.g. "Users/Admin". Kept so empty folders survive. */
  folders: string[];
}

export interface RequestItem {
  id: string;
  name: string;
  /** The collection this request is saved in. */
  collectionId: string;
  /** Folder path inside the collection, e.g. "users/admin". Empty = top level of the collection. */
  folder: string;
  method: HttpMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: Auth;
  /** Values to copy into global variables after every send (e.g. an access token). */
  captures?: Capture[];
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
  /** multipart/form-data fields, in place of `body`. The engine builds the bytes and the Content-Type. */
  multipart?: ResolvedPart[];
  /** A file sent as the whole body, in place of `body`. */
  file?: FileRef;
  timeoutMs?: number;
  followRedirects?: boolean;
}

export type ResolvedPart = { name: string; value: string } | { name: string; file: FileRef };

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
  collections: Collection[];
  requests: RequestItem[];
  /** Variables available in every request. An active environment's variable with the same name wins. */
  globals: EnvVar[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  mcpServers: McpServerConfig[];
  history: HistoryEntry[];
}

export function emptyWorkspace(name = 'My workspace'): Workspace {
  return { name, collections: [], requests: [], globals: [], environments: [], activeEnvironmentId: null, mcpServers: [], history: [] };
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function newRequest(partial: Partial<RequestItem> = {}): RequestItem {
  return {
    id: newId(),
    name: 'New request',
    collectionId: '',
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
