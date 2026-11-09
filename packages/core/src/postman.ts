import { HTTP_METHODS, newId, newRequest, type Auth, type Environment, type HttpMethod, type KeyValue, type RequestItem } from './types';

// Minimal shapes of the Postman Collection v2.0/v2.1 format we read.
interface PmKV { key?: string; value?: string; disabled?: boolean; type?: string }
interface PmUrl { raw?: string; query?: PmKV[] }
interface PmBody { mode?: string; raw?: string; urlencoded?: PmKV[]; formdata?: PmKV[]; graphql?: { query?: string; variables?: string }; options?: { raw?: { language?: string } } }
interface PmAuth { type?: string; [k: string]: unknown }
interface PmRequest { method?: string; header?: PmKV[] | string; url?: string | PmUrl; body?: PmBody; auth?: PmAuth }
interface PmItem { name?: string; item?: PmItem[]; request?: PmRequest | string; auth?: PmAuth }
interface PmCollection { info?: { name?: string; schema?: string }; item?: PmItem[]; variable?: PmKV[]; auth?: PmAuth }

export interface PostmanImport {
  name: string;
  requests: RequestItem[];
  environment: Environment | null;
  warnings: string[];
}

const kv = (list: PmKV[] | undefined): KeyValue[] =>
  (list ?? []).filter((x) => x && x.key).map((x) => ({ key: String(x.key), value: String(x.value ?? ''), enabled: !x.disabled }));

function authParam(auth: PmAuth, name: string): string {
  const list = auth[auth.type ?? ''];
  if (Array.isArray(list)) {
    const hit = (list as PmKV[]).find((p) => p.key === name);
    return hit ? String(hit.value ?? '') : '';
  }
  if (list && typeof list === 'object') return String((list as Record<string, unknown>)[name] ?? '');
  return '';
}

function convertAuth(auth: PmAuth | undefined, warnings: string[], where: string): Auth | null {
  if (!auth || !auth.type) return null;
  switch (auth.type) {
    case 'noauth': return { type: 'none' };
    case 'bearer': return { type: 'bearer', token: authParam(auth, 'token') };
    case 'basic': return { type: 'basic', username: authParam(auth, 'username'), password: authParam(auth, 'password') };
    case 'apikey':
      return { type: 'apikey', key: authParam(auth, 'key'), value: authParam(auth, 'value'), in: authParam(auth, 'in') === 'query' ? 'query' : 'header' };
    default:
      warnings.push(`${where}: auth type "${auth.type}" not supported yet`);
      return null;
  }
}

function convertRequest(name: string, folder: string, pm: PmRequest | string, inheritedAuth: Auth | null, warnings: string[]): RequestItem {
  if (typeof pm === 'string') return newRequest({ name, folder, url: pm });
  const method = String(pm.method ?? 'GET').toUpperCase() as HttpMethod;
  const req = newRequest({ name, folder, method: HTTP_METHODS.includes(method) ? method : 'GET' });

  if (typeof pm.url === 'string') req.url = pm.url;
  else if (pm.url) {
    // Keep the raw URL without its query and move query into params so they stay editable.
    const raw = pm.url.raw ?? '';
    const q = raw.indexOf('?');
    if (pm.url.query?.length && q >= 0) {
      req.url = raw.slice(0, q);
      req.params = kv(pm.url.query);
    } else req.url = raw;
  }

  if (Array.isArray(pm.header)) req.headers = kv(pm.header);

  const body = pm.body;
  if (body?.mode === 'raw') {
    const lang = body.options?.raw?.language;
    let isJson = lang === 'json';
    if (!lang) {
      try { JSON.parse(body.raw ?? ''); isJson = true; } catch { /* text */ }
    }
    req.body = { mode: isJson ? 'json' : 'text', text: body.raw ?? '', form: [] };
    if (isJson) req.headers = req.headers.filter((h) => h.key.toLowerCase() !== 'content-type');
  } else if (body?.mode === 'urlencoded') {
    req.body = { mode: 'form-urlencoded', text: '', form: kv(body.urlencoded) };
  } else if (body?.mode === 'graphql') {
    let variables: unknown = {};
    try { variables = body.graphql?.variables ? JSON.parse(body.graphql.variables) : {}; } catch { /* keep {} */ }
    req.body = { mode: 'json', text: JSON.stringify({ query: body.graphql?.query ?? '', variables }, null, 2), form: [] };
  } else if (body?.mode === 'formdata') {
    warnings.push(`${name}: multipart form-data body not supported yet (fields kept as urlencoded)`);
    req.body = { mode: 'form-urlencoded', text: '', form: kv((body.formdata ?? []).filter((f) => f.type !== 'file')) };
  }

  const own = convertAuth(pm.auth, warnings, name);
  req.auth = own ?? inheritedAuth ?? { type: 'none' };
  return req;
}

export function isPostmanCollection(json: unknown): json is PmCollection {
  const j = json as PmCollection;
  return !!j && typeof j === 'object' && Array.isArray(j.item) && typeof j.info?.schema === 'string' && j.info.schema.includes('getpostman.com');
}

export function importPostmanCollection(json: unknown): PostmanImport {
  if (!isPostmanCollection(json)) throw new Error('Not a Postman v2.x collection (missing info.schema)');
  const warnings: string[] = [];
  const requests: RequestItem[] = [];
  const name = json.info?.name ?? 'Imported collection';

  const walk = (items: PmItem[], folder: string, auth: Auth | null) => {
    for (const it of items) {
      const itemAuth = convertAuth(it.auth, warnings, it.name ?? 'folder') ?? auth;
      if (Array.isArray(it.item)) {
        walk(it.item, folder ? `${folder}/${it.name ?? 'folder'}` : it.name ?? 'folder', itemAuth);
      } else if (it.request) {
        requests.push(convertRequest(it.name ?? 'Request', folder, it.request, itemAuth, warnings));
      }
    }
  };
  walk(json.item ?? [], name, convertAuth(json.auth, warnings, 'collection'));

  const vars = kv(json.variable);
  const environment: Environment | null = vars.length
    ? { id: newId(), name: `${name} variables`, variables: vars.map((v) => ({ ...v })) }
    : null;
  return { name, requests, environment, warnings };
}

interface PmEnvironment { name?: string; values?: PmKV[]; _postman_variable_scope?: string }

export function importPostmanEnvironment(json: unknown): Environment {
  const e = json as PmEnvironment;
  if (!e || !Array.isArray(e.values)) throw new Error('Not a Postman environment file');
  return {
    id: newId(),
    name: e.name ?? 'Imported environment',
    variables: e.values.filter((v) => v.key).map((v) => ({ key: String(v.key), value: String(v.value ?? ''), enabled: v.disabled !== true && (v as { enabled?: boolean }).enabled !== false, secret: v.type === 'secret' })),
  };
}
