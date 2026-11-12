import type { Auth, Environment, KeyValue, RequestItem, ResolvedPart, ResolvedRequest } from './types';
import { fileContentType } from './files';

const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

export type VarMap = Record<string, string>;

/** Built-in dynamic variables, evaluated fresh on every send. */
const DYNAMIC: Record<string, () => string> = {
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $uuid: () => globalThis.crypto.randomUUID(),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
};

export function envToVars(env: Environment | null | undefined): VarMap {
  const vars: VarMap = {};
  for (const v of env?.variables ?? []) if (v.enabled && v.key) vars[v.key] = v.value;
  return vars;
}

/** Replace {{name}} placeholders. Unknown names are left as-is and reported in `missing`. */
export function interpolate(input: string, vars: VarMap, missing?: Set<string>): string {
  return input.replace(VAR_RE, (whole, name: string) => {
    if (name in vars) return vars[name];
    const dyn = DYNAMIC[name];
    if (dyn) return dyn();
    missing?.add(name);
    return whole;
  });
}

export function findVariables(input: string): string[] {
  return [...input.matchAll(VAR_RE)].map((m) => m[1]);
}

const enabled = (list: KeyValue[]) => list.filter((kv) => kv.enabled && kv.key.trim() !== '');

/** Append enabled query params to a URL without touching params already in it. */
export function buildUrl(url: string, params: KeyValue[]): string {
  const extra = enabled(params);
  if (extra.length === 0) return url;
  const qs = extra.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
  const hashIdx = url.indexOf('#');
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
  const sep = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  return base + sep + qs + hash;
}

function hasHeader(headers: [string, string][], name: string) {
  const n = name.toLowerCase();
  return headers.some(([k]) => k.toLowerCase() === n);
}

function toBase64(s: string): string {
  // UTF-8 safe base64 that works in Node and browsers.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface ResolveResult {
  request: ResolvedRequest;
  missing: string[];
  /** The request's auth with variables filled in. Signed kinds (JWT, OAuth 1.0, Hawk, AWS, Digest) are added by prepareRequest. */
  auth: Auth;
}

/** Apply environment variables, params, auth and body defaults. Pure, so every shell sends identical bytes. */
export function resolveRequest(item: RequestItem, vars: VarMap): ResolveResult {
  const missing = new Set<string>();
  const t = (s: string) => interpolate(s, vars, missing);

  const params: KeyValue[] = enabled(item.params).map((p) => ({ ...p, key: t(p.key), value: t(p.value) }));
  const headers: [string, string][] = enabled(item.headers).map((h) => [t(h.key), t(h.value)]);

  // Every text setting of the auth can hold {{variables}}.
  const auth = Object.fromEntries(Object.entries(item.auth).map(([k, v]) => [k, typeof v === 'string' && k !== 'type' ? t(v) : v])) as Auth;
  if (auth.type === 'bearer' && auth.token && !hasHeader(headers, 'authorization')) {
    headers.push(['Authorization', `Bearer ${auth.token}`]);
  } else if (auth.type === 'basic' && !hasHeader(headers, 'authorization')) {
    headers.push(['Authorization', `Basic ${toBase64(`${auth.username}:${auth.password}`)}`]);
  } else if (auth.type === 'apikey' && auth.key) {
    if (auth.in === 'query') params.push({ key: auth.key, value: auth.value, enabled: true });
    else headers.push([auth.key, auth.value]);
  } else if (auth.type === 'oauth2' && auth.token && !hasHeader(headers, 'authorization')) {
    headers.push(['Authorization', `${auth.prefix.trim() || 'Bearer'} ${auth.token}`]);
  }

  let body: string | undefined;
  const b = item.body;
  if (b.mode === 'json' || b.mode === 'text') {
    body = t(b.text);
    if (b.mode === 'json' && !hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json']);
  } else if (b.mode === 'form-urlencoded') {
    body = enabled(b.form)
      .map((f) => `${encodeURIComponent(t(f.key))}=${encodeURIComponent(t(f.value))}`)
      .join('&');
    if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  }

  const sendsBody = item.method !== 'GET' && item.method !== 'HEAD';
  let multipart: ResolvedPart[] | undefined;
  let file: ResolvedRequest['file'];
  if (b.mode === 'multipart' && sendsBody) {
    multipart = [];
    for (const f of b.multipart ?? []) {
      if (!f.enabled || !f.key.trim()) continue;
      if (f.file) multipart.push({ name: t(f.key), file: f.file });
      else if (f.file === undefined) multipart.push({ name: t(f.key), value: t(f.value) });
      // file === null: a file field with nothing chosen yet is left out
    }
    // The engine writes Content-Type itself, because only it knows the boundary between the parts.
    for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0].toLowerCase() === 'content-type') headers.splice(i, 1);
  } else if (b.mode === 'file' && b.file && sendsBody) {
    file = b.file;
    if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', fileContentType(b.file)]);
  }

  let url = t(item.url.trim());
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  url = buildUrl(url, params);

  return {
    request: { method: item.method, url, headers, body: sendsBody ? body : undefined, ...(multipart ? { multipart } : {}), ...(file ? { file } : {}) },
    missing: [...missing],
    auth,
  };
}
