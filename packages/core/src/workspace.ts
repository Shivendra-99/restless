// Workspace-level helpers: collections and folders, global variables, and "save from response" captures.
import { findVariables } from './variables';
import { emptyWorkspace, newId, type Capture, type Collection, type EnvVar, type HttpResponse, type RequestItem, type Workspace } from './types';

export const DEFAULT_COLLECTION_NAME = 'My collection';

const cleanFolder = (f: string | undefined) =>
  (f ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/');

/** Fill missing fields from older saves and put requests without a valid collection into one. */
export function normalizeWorkspace(input: Partial<Workspace> | null | undefined): Workspace {
  const ws: Workspace = { ...emptyWorkspace(), ...(input ?? {}) } as Workspace;
  ws.collections = (ws.collections ?? []).map((c) => ({ id: c.id, name: c.name || 'Untitled collection', folders: [...new Set((c.folders ?? []).map(cleanFolder).filter(Boolean))] }));
  ws.globals = ws.globals ?? [];
  ws.requests = (ws.requests ?? []).map((r) => ({ ...r, folder: cleanFolder(r.folder), collectionId: r.collectionId ?? '', captures: r.captures ?? [] }));
  ws.environments = ws.environments ?? [];
  ws.mcpServers = ws.mcpServers ?? [];
  ws.history = ws.history ?? [];

  const known = new Set(ws.collections.map((c) => c.id));
  const orphans = ws.requests.filter((r) => !known.has(r.collectionId));
  if (orphans.length) {
    let target = ws.collections.find((c) => c.name === DEFAULT_COLLECTION_NAME);
    if (!target) {
      target = { id: newId(), name: DEFAULT_COLLECTION_NAME, folders: [] };
      ws.collections = [...ws.collections, target];
    }
    const id = target.id;
    ws.requests = ws.requests.map((r) => (known.has(r.collectionId) ? r : { ...r, collectionId: id }));
  }
  return ws;
}

export function newCollection(name: string, existing: Collection[]): Collection {
  const names = new Set(existing.map((c) => c.name));
  let n = name.trim() || 'New collection';
  if (names.has(n)) {
    let i = 2;
    while (names.has(`${n} ${i}`)) i++;
    n = `${n} ${i}`;
  }
  return { id: newId(), name: n, folders: [] };
}

/** Every folder path in a collection, including parents of request folders, sorted. */
export function collectionFolders(c: Collection, requests: RequestItem[]): string[] {
  const out = new Set<string>();
  const add = (path: string) => {
    const parts = cleanFolder(path).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
  };
  c.folders.forEach(add);
  requests.filter((r) => r.collectionId === c.id).forEach((r) => add(r.folder));
  return [...out].sort((a, b) => a.localeCompare(b));
}

const inFolder = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

export function addFolder(ws: Workspace, collectionId: string, parent: string, name: string): Workspace {
  const path = cleanFolder(parent ? `${parent}/${name.replace(/\//g, '-')}` : name.replace(/\//g, '-'));
  if (!path) return ws;
  return { ...ws, collections: ws.collections.map((c) => (c.id === collectionId ? { ...c, folders: [...new Set([...c.folders, path])] } : c)) };
}

export function renameFolder(ws: Workspace, collectionId: string, path: string, newName: string): Workspace {
  const name = newName.trim().replace(/\//g, '-');
  if (!name) return ws;
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const next = parent ? `${parent}/${name}` : name;
  const move = (p: string) => (inFolder(p, path) ? next + p.slice(path.length) : p);
  return {
    ...ws,
    collections: ws.collections.map((c) => (c.id === collectionId ? { ...c, folders: [...new Set(c.folders.map(move))] } : c)),
    requests: ws.requests.map((r) => (r.collectionId === collectionId ? { ...r, folder: move(r.folder) } : r)),
  };
}

/** Removes the folder, its sub-folders and every request inside them. */
export function deleteFolder(ws: Workspace, collectionId: string, path: string): Workspace {
  return {
    ...ws,
    collections: ws.collections.map((c) => (c.id === collectionId ? { ...c, folders: c.folders.filter((f) => !inFolder(f, path)) } : c)),
    requests: ws.requests.filter((r) => !(r.collectionId === collectionId && inFolder(r.folder, path))),
  };
}

export function countInFolder(ws: Workspace, collectionId: string, path: string): number {
  return ws.requests.filter((r) => r.collectionId === collectionId && inFolder(r.folder, path)).length;
}

// ---------------------------------------------------------------- variables

export type VariableScope = 'global' | 'environment';

export interface VariableInfo {
  name: string;
  value: string;
  scope: VariableScope;
  secret: boolean;
}

/** All variables a request can use: globals, overridden by the active environment. */
export function resolveVariables(ws: Workspace): Map<string, VariableInfo> {
  const out = new Map<string, VariableInfo>();
  for (const v of ws.globals) if (v.enabled && v.key) out.set(v.key, { name: v.key, value: v.value, scope: 'global', secret: !!v.secret });
  const env = ws.environments.find((e) => e.id === ws.activeEnvironmentId);
  for (const v of env?.variables ?? []) if (v.enabled && v.key) out.set(v.key, { name: v.key, value: v.value, scope: 'environment', secret: !!v.secret });
  return out;
}

export function variableMap(ws: Workspace): Record<string, string> {
  return Object.fromEntries([...resolveVariables(ws)].map(([k, v]) => [k, v.value]));
}

/** Names of {{variables}} a request refers to, in order of first use. */
export function usedVariables(item: RequestItem): string[] {
  const texts: string[] = [item.url];
  for (const kv of [...item.params, ...item.headers]) if (kv.enabled) texts.push(kv.key, kv.value);
  if (item.body.mode === 'form-urlencoded') for (const kv of item.body.form) if (kv.enabled) texts.push(kv.key, kv.value);
  if (item.body.mode === 'multipart') for (const f of item.body.multipart ?? []) if (f.enabled) texts.push(f.key, f.file === undefined ? f.value : '');
  if (item.body.mode === 'json' || item.body.mode === 'text') texts.push(item.body.text);
  for (const [k, v] of Object.entries(item.auth)) if (k !== 'type' && typeof v === 'string') texts.push(v);
  const seen = new Set<string>();
  for (const t of texts) for (const name of findVariables(t)) if (!name.startsWith('$')) seen.add(name);
  return [...seen];
}

/** Variable names may not contain spaces or braces; everything else is allowed. */
export function cleanVariableName(name: string): string {
  return name.trim().replace(/[{}\s]+/g, '_');
}

/** Create or update a global. New globals are kept on this machine only (secret), since they usually hold tokens. */
export function setGlobal(globals: EnvVar[], key: string, value: string): EnvVar[] {
  const k = cleanVariableName(key);
  if (!k) return globals;
  const i = globals.findIndex((g) => g.key === k);
  if (i >= 0) return globals.map((g, j) => (j === i ? { ...g, value, enabled: true } : g));
  return [...globals, { key: k, value, enabled: true, secret: true }];
}

// ---------------------------------------------------------------- JSON paths

export type PathSegment = string | number;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

export function formatPath(segments: PathSegment[]): string {
  let out = '';
  for (const s of segments) {
    if (typeof s === 'number') out += `[${s}]`;
    else if (IDENT.test(s)) out += out ? `.${s}` : s;
    else out += `[${JSON.stringify(s)}]`;
  }
  return out;
}

export function parsePath(path: string): PathSegment[] {
  const out: PathSegment[] = [];
  const s = path.trim().replace(/^\$\.?/, '');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      i++;
      continue;
    }
    if (c === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) throw new Error(`Missing "]" in path ${path}`);
      const inner = s.slice(i + 1, end).trim();
      if (/^\d+$/.test(inner)) out.push(Number(inner));
      else if (/^".*"$|^'.*'$/.test(inner)) out.push(inner.startsWith('"') ? JSON.parse(inner) : inner.slice(1, -1));
      else out.push(inner);
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

export function getAtPath(value: unknown, segments: PathSegment[]): unknown {
  let cur = value;
  for (const s of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[s];
  }
  return cur;
}

/** A readable variable name from where a value came from, e.g. data.access_token → access_token. */
export function suggestVariableName(segments: PathSegment[]): string {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (typeof segments[i] === 'string') return cleanVariableName(String(segments[i])) || 'value';
  }
  return 'value';
}

const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

// ---------------------------------------------------------------- captures

export type CaptureResult = { ok: true; value: string } | { ok: false; reason: string };

export function extractCapture(c: Capture, res: HttpResponse): CaptureResult {
  if (c.from === 'header') {
    const hit = res.headers.find(([k]) => k.toLowerCase() === c.path.trim().toLowerCase());
    return hit ? { ok: true, value: hit[1] } : { ok: false, reason: `header ${c.path} is not in the response` };
  }
  if (!c.path.trim()) return { ok: true, value: res.body };
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return { ok: false, reason: 'the response body is not JSON' };
  }
  let segs: PathSegment[];
  try {
    segs = parsePath(c.path);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const v = getAtPath(json, segs);
  return v === undefined ? { ok: false, reason: `${c.path} is not in the response` } : { ok: true, value: asText(v) };
}

export interface CaptureRun {
  updated: { variable: string; value: string }[];
  missed: { variable: string; reason: string }[];
  globals: EnvVar[];
}

/** Apply a request's captures after a successful (2xx) response. Other statuses change nothing. */
export function runCaptures(item: RequestItem, res: HttpResponse, globals: EnvVar[]): CaptureRun {
  const run: CaptureRun = { updated: [], missed: [], globals };
  const caps = item.captures ?? [];
  if (!caps.length) return run;
  if (res.error || res.status < 200 || res.status >= 300) {
    run.missed = caps.map((c) => ({ variable: c.variable, reason: `the response was ${res.error ? 'an error' : res.status}, not 2xx` }));
    return run;
  }
  for (const c of caps) {
    const r = extractCapture(c, res);
    if (r.ok) {
      run.globals = setGlobal(run.globals, c.variable, r.value);
      run.updated.push({ variable: c.variable, value: r.value });
    } else run.missed.push({ variable: c.variable, reason: r.reason });
  }
  return run;
}

export function describeCapture(c: Capture): string {
  if (c.from === 'header') return `header ${c.path}`;
  if (!c.path) return 'whole body';
  return c.path.startsWith('[') ? `body${c.path}` : `body.${c.path}`;
}
