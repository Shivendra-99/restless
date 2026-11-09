import type { Environment, KeyValue, RequestItem, ResolvedRequest } from './types';

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
}

/** Apply environment variables, params, auth and body defaults. Pure, so every shell sends identical bytes. */
export function resolveRequest(item: RequestItem, vars: VarMap): ResolveResult {
  const missing = new Set<string>();
  const t = (s: string) => interpolate(s, vars, missing);

  const params: KeyValue[] = enabled(item.params).map((p) => ({ ...p, key: t(p.key), value: t(p.value) }));
  const headers: [string, string][] = enabled(item.headers).map((h) => [t(h.key), t(h.value)]);

  const auth = item.auth;
  if (auth.type === 'bearer' && auth.token && !hasHeader(headers, 'authorization')) {
    headers.push(['Authorization', `Bearer ${t(auth.token)}`]);
  } else if (auth.type === 'basic' && !hasHeader(headers, 'authorization')) {
    headers.push(['Authorization', `Basic ${toBase64(`${t(auth.username)}:${t(auth.password)}`)}`]);
  } else if (auth.type === 'apikey' && auth.key) {
    if (auth.in === 'query') params.push({ key: t(auth.key), value: t(auth.value), enabled: true });
    else headers.push([t(auth.key), t(auth.value)]);
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

  let url = t(item.url.trim());
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  url = buildUrl(url, params);

  return {
    request: { method: item.method, url, headers, body: item.method === 'GET' || item.method === 'HEAD' ? undefined : body },
    missing: [...missing],
  };
}
