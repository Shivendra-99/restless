// Network capture: requests recorded by the desktop app's built-in browser, or imported from a HAR file.
import { HTTP_METHODS, newId, newRequest, type HttpMethod, type KeyValue, type RequestItem, type ResolvedRequest } from './types';

export type CaptureSource = 'browser' | 'har';

export interface CapturedEntry {
  id: string;
  sessionId: string;
  /** Epoch milliseconds when the request started. */
  startedAt: number;
  method: string;
  url: string;
  /** fetch, xhr, document, script, image… (lowercase). */
  type: string;
  requestHeaders: [string, string][];
  requestBody?: string;
  status?: number;
  statusText?: string;
  responseHeaders: [string, string][];
  responseBody?: string;
  /** Set when responseBody is base64 (binary content such as images). */
  responseBodyBase64?: boolean;
  mimeType?: string;
  durationMs?: number;
  /** Transferred bytes when known. */
  size?: number;
  /** Network failure, e.g. net::ERR_CONNECTION_REFUSED. */
  error?: string;
  /** Why a body is missing or cut, shown next to it. */
  note?: string;
  /** Page that made the request. */
  pageUrl?: string;
}

export interface CaptureSession {
  id: string;
  name: string;
  source: CaptureSource;
  startedAt: number;
  endedAt?: number;
  pageUrl?: string;
  /** Still receiving requests. */
  live?: boolean;
  entryCount: number;
}

export const MAX_BODY_CHARS = 1_000_000;
const API_TYPES = new Set(['fetch', 'xhr', 'xmlhttprequest']);

export const isApiType = (type: string) => API_TYPES.has(type.toLowerCase());

export function newSession(partial: Partial<CaptureSession> & Pick<CaptureSession, 'name' | 'source'>): CaptureSession {
  return { id: newId(), startedAt: Date.now(), entryCount: 0, ...partial };
}

/** Keep huge bodies from filling storage; the note tells the user what happened. */
export function capBody(body: string | undefined, entry: Pick<CapturedEntry, 'note'>): string | undefined {
  if (body === undefined || body.length <= MAX_BODY_CHARS) return body;
  entry.note = `Body was ${(body.length / 1_000_000).toFixed(1)} MB; only the first 1 MB is kept.`;
  return body.slice(0, MAX_BODY_CHARS);
}

export const headerList = (h: Record<string, string | string[] | undefined> | undefined): [string, string][] =>
  Object.entries(h ?? {}).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : String(v).split('\n').map((x) => [k, x] as [string, string])));

export const getHeader = (headers: [string, string][], name: string) => headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** Response body as text, decoding base64 when the content is textual. Null for binary. */
export function responseText(e: CapturedEntry): string | null {
  if (e.responseBody === undefined) return null;
  if (!e.responseBodyBase64) return e.responseBody;
  const mime = (e.mimeType ?? getHeader(e.responseHeaders, 'content-type') ?? '').toLowerCase();
  if (!/json|text|xml|javascript|html|csv|x-www-form-urlencoded|graphql/.test(mime)) return null;
  try {
    const bin = atob(e.responseBody);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- turning a capture into a request

/** Headers the engine or browser sets on its own; copying them breaks requests (wrong length, HTTP/2 pseudo headers). */
const DROP = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'keep-alive', 'transfer-encoding', 'te', 'upgrade']);
/** Browser fingerprint headers: kept for reference but switched off. */
const OFF = /^(sec-ch-|sec-fetch-|sec-gpc$|priority$|upgrade-insecure-requests$)/i;

export function capturedHeaders(e: CapturedEntry): KeyValue[] {
  return e.requestHeaders
    .filter(([k]) => !k.startsWith(':') && !DROP.has(k.toLowerCase()))
    .map(([key, value]) => ({ key, value, enabled: !OFF.test(key) }));
}

/** A saved request built from a captured one: same method, URL, headers (incl. cookies) and body. */
export function capturedToRequest(e: CapturedEntry, collectionId: string, folder = ''): RequestItem {
  const method = (HTTP_METHODS as string[]).includes(e.method.toUpperCase()) ? (e.method.toUpperCase() as HttpMethod) : 'GET';
  let name = `${method} ${e.url}`;
  try {
    const u = new URL(e.url);
    name = `${method} ${u.pathname}`;
  } catch {
    /* keep */
  }
  const headers = capturedHeaders(e);
  const req = newRequest({ name, method, url: e.url, headers, collectionId, folder });
  const body = e.requestBody;
  if (body !== undefined && body !== '' && method !== 'GET' && method !== 'HEAD') {
    const ct = (getHeader(e.requestHeaders, 'content-type') ?? '').toLowerCase();
    const looksJson = /^[[{]/.test(body.trim());
    let json = false;
    if (ct.includes('json') || (!ct && looksJson)) {
      try {
        req.body = { mode: 'json', text: JSON.stringify(JSON.parse(body), null, 2), form: [] };
        json = true;
      } catch {
        /* not valid JSON; keep as text */
      }
    }
    if (!json && ct.includes('x-www-form-urlencoded')) {
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      req.body = {
        mode: 'form-urlencoded',
        text: '',
        form: body.split('&').filter(Boolean).map((p) => {
          const i = p.indexOf('=');
          return { key: dec(i >= 0 ? p.slice(0, i) : p), value: dec(i >= 0 ? p.slice(i + 1) : ''), enabled: true };
        }),
      };
    } else if (!json) req.body = { mode: 'text', text: body, form: [] };
    // The body modes add their own Content-Type; drop the captured duplicate for JSON and forms.
    if (req.body.mode !== 'text') req.headers = req.headers.filter((h) => h.key.toLowerCase() !== 'content-type');
  }
  return req;
}

/** What was sent, in the shape toCurl() expects. */
export function capturedToResolved(e: CapturedEntry): ResolvedRequest {
  return {
    method: ((HTTP_METHODS as string[]).includes(e.method.toUpperCase()) ? e.method.toUpperCase() : 'GET') as HttpMethod,
    url: e.url,
    headers: capturedHeaders(e).filter((h) => h.enabled).map((h) => [h.key, h.value]),
    body: e.requestBody,
  };
}

// ---------------------------------------------------------------- HAR

interface HarNV { name: string; value: string }
export interface HarEntry {
  startedDateTime: string;
  time?: number;
  request: { method: string; url: string; headers?: HarNV[]; postData?: { mimeType?: string; text?: string } };
  response?: { status?: number; statusText?: string; headers?: HarNV[]; content?: { size?: number; mimeType?: string; text?: string; encoding?: string }; _error?: string };
  _resourceType?: string;
  _transferSize?: number;
}

const nv = (list: HarNV[] | undefined): [string, string][] => (list ?? []).map((h) => [h.name, h.value]);

/** One HAR entry → a captured entry. `content` overrides the body (DevTools getContent()). */
export function harToEntry(h: HarEntry, sessionId: string, content?: { text: string | null; encoding?: string }): CapturedEntry {
  const res = h.response ?? {};
  const started = Date.parse(h.startedDateTime);
  const e: CapturedEntry = {
    id: newId(),
    sessionId,
    startedAt: Number.isFinite(started) ? started : Date.now(),
    method: h.request.method,
    url: h.request.url,
    type: (h._resourceType ?? 'other').toLowerCase(),
    requestHeaders: nv(h.request.headers),
    responseHeaders: nv(res.headers),
    status: res.status || undefined,
    statusText: res.statusText,
    mimeType: res.content?.mimeType,
    durationMs: h.time !== undefined && h.time >= 0 ? Math.round(h.time) : undefined,
    size: h._transferSize ?? res.content?.size,
  };
  if (!res.status && res._error) e.error = res._error;
  e.requestBody = capBody(h.request.postData?.text, e);
  const text = content ? content.text : res.content?.text;
  const enc = content ? content.encoding : res.content?.encoding;
  if (text !== null && text !== undefined) {
    e.responseBody = capBody(text, e);
    if (enc === 'base64') e.responseBodyBase64 = true;
  }
  return e;
}

export function parseHar(text: string, name = 'Imported HAR'): { session: CaptureSession; entries: CapturedEntry[] } {
  let json: { log?: { entries?: HarEntry[]; pages?: { title?: string }[] } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON, so it is not a HAR file.');
  }
  const list = json?.log?.entries;
  if (!Array.isArray(list)) throw new Error('No log.entries found. Export a HAR from the browser’s Network tab ("Save all as HAR").');
  const session = newSession({ name, source: 'har', pageUrl: json.log?.pages?.[0]?.title });
  const entries = list.filter((h) => h?.request?.url).map((h) => harToEntry(h, session.id));
  entries.sort((a, b) => a.startedAt - b.startedAt);
  session.startedAt = entries[0]?.startedAt ?? Date.now();
  session.endedAt = entries.length ? entries[entries.length - 1].startedAt : session.startedAt;
  session.entryCount = entries.length;
  return { session, entries };
}

/** Export a session as HAR 1.2 so it opens in browser DevTools and other tools. */
export function buildHar(session: CaptureSession, entries: CapturedEntry[]): object {
  const toNV = (h: [string, string][]) => h.map(([name, value]) => ({ name, value }));
  return {
    log: {
      version: '1.2',
      creator: { name: 'Restless', version: '0.4.1' },
      pages: [],
      entries: entries.map((e) => {
        let query: HarNV[] = [];
        try {
          query = [...new URL(e.url).searchParams].map(([name, value]) => ({ name, value }));
        } catch {
          /* relative or invalid */
        }
        return {
          startedDateTime: new Date(e.startedAt).toISOString(),
          time: e.durationMs ?? 0,
          request: {
            method: e.method,
            url: e.url,
            httpVersion: 'HTTP/1.1',
            headers: toNV(e.requestHeaders),
            queryString: query,
            cookies: [],
            headersSize: -1,
            bodySize: e.requestBody?.length ?? 0,
            ...(e.requestBody !== undefined ? { postData: { mimeType: getHeader(e.requestHeaders, 'content-type') ?? '', text: e.requestBody } } : {}),
          },
          response: {
            status: e.status ?? 0,
            statusText: e.statusText ?? '',
            httpVersion: 'HTTP/1.1',
            headers: toNV(e.responseHeaders),
            cookies: [],
            content: {
              size: e.size ?? e.responseBody?.length ?? 0,
              mimeType: e.mimeType ?? '',
              ...(e.responseBody !== undefined ? { text: e.responseBody } : {}),
              ...(e.responseBodyBase64 ? { encoding: 'base64' } : {}),
            },
            redirectURL: getHeader(e.responseHeaders, 'location') ?? '',
            headersSize: -1,
            bodySize: e.size ?? -1,
            ...(e.error ? { _error: e.error } : {}),
          },
          cache: {},
          timings: { send: 0, wait: e.durationMs ?? 0, receive: 0 },
          _resourceType: e.type,
        };
      }),
    },
  };
}

/** What someone types in an address bar → a URL to load. "localhost:3000" → http, "example.com" → https. Null if not allowed. */
export function normalizeAddress(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^(https?|about):/i.test(s)) return s;
  if (/^[a-z][\w+.-]*:/i.test(s) && !/^[\w.-]+:\d+(\/|$)/.test(s)) return null; // file:, chrome:, javascript: …
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|[\w-]+\.local)(:\d+)?(\/|$)/i.test(s);
  return `${local ? 'http' : 'https'}://${s}`;
}
