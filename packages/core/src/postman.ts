import { HTTP_METHODS, newAuth, newId, newRequest, type Auth, type Capture, type Collection, type Environment, type EnvVar, type HttpMethod, type FormField, type KeyValue, type RequestItem } from './types';
import { guessContentType } from './files';
import { collectionFolders, formatPath, parsePath } from './workspace';

// Minimal shapes of the Postman Collection v2.0/v2.1 format we read and write.
interface PmKV { key?: string; value?: string; disabled?: boolean; type?: string; enabled?: boolean; src?: string | string[] | null; contentType?: string }
interface PmUrl { raw?: string; query?: PmKV[] }
interface PmBody { mode?: string; raw?: string; file?: { src?: string | null }; urlencoded?: PmKV[]; formdata?: PmKV[]; graphql?: { query?: string; variables?: string }; options?: { raw?: { language?: string } } }
interface PmAuth { type?: string; [k: string]: unknown }
interface PmRequest { method?: string; header?: PmKV[] | string; url?: string | PmUrl; body?: PmBody; auth?: PmAuth }
interface PmEvent { listen?: string; script?: { exec?: string[] | string; type?: string } }
interface PmItem { name?: string; item?: PmItem[]; request?: PmRequest | string; auth?: PmAuth; event?: PmEvent[] }
interface PmCollection { info?: { name?: string; schema?: string }; item?: PmItem[]; variable?: PmKV[]; auth?: PmAuth }

export const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

export interface PostmanImport {
  collection: Collection;
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
    case 'digest': return { type: 'digest', username: authParam(auth, 'username'), password: authParam(auth, 'password') };
    case 'oauth1': {
      const method = authParam(auth, 'signatureMethod');
      return {
        type: 'oauth1',
        consumerKey: authParam(auth, 'consumerKey'),
        consumerSecret: authParam(auth, 'consumerSecret'),
        token: authParam(auth, 'token'),
        tokenSecret: authParam(auth, 'tokenSecret'),
        signatureMethod: method === 'HMAC-SHA256' || method === 'PLAINTEXT' ? method : 'HMAC-SHA1',
        realm: authParam(auth, 'realm'),
      };
    }
    case 'oauth2': {
      const grant = authParam(auth, 'grant_type');
      return {
        ...(newAuth('oauth2') as Extract<Auth, { type: 'oauth2' }>),
        grant: grant === 'password_credentials' ? 'password' : grant === 'client_credentials' ? 'client_credentials' : 'authorization_code',
        tokenUrl: authParam(auth, 'accessTokenUrl'),
        authUrl: authParam(auth, 'authUrl'),
        redirectUri: authParam(auth, 'redirect_uri') || 'http://localhost/callback',
        clientId: authParam(auth, 'clientId'),
        clientSecret: authParam(auth, 'clientSecret'),
        scope: authParam(auth, 'scope'),
        username: authParam(auth, 'username'),
        password: authParam(auth, 'password'),
        clientAuth: authParam(auth, 'client_authentication') === 'body' ? 'body' : 'basic',
        token: authParam(auth, 'accessToken'),
        prefix: authParam(auth, 'headerPrefix').trim() || 'Bearer',
      };
    }
    case 'hawk': return { type: 'hawk', id: authParam(auth, 'authId'), key: authParam(auth, 'authKey'), algorithm: authParam(auth, 'algorithm') === 'sha1' ? 'sha1' : 'sha256', ext: authParam(auth, 'extraData') };
    case 'awsv4':
      return { type: 'aws', accessKey: authParam(auth, 'accessKey'), secretKey: authParam(auth, 'secretKey'), region: authParam(auth, 'region') || 'us-east-1', service: authParam(auth, 'service'), sessionToken: authParam(auth, 'sessionToken') };
    case 'jwt': {
      const alg = authParam(auth, 'algorithm');
      const base = newAuth('jwt') as Extract<Auth, { type: 'jwt' }>;
      return {
        ...base,
        algorithm: (['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'].includes(alg) ? alg : 'HS256') as typeof base.algorithm,
        secret: authParam(auth, alg.startsWith('HS') || !alg ? 'secret' : 'privateKey'),
        secretBase64: authParam(auth, 'isSecretBase64Encoded') === 'true',
        payload: authParam(auth, 'payload') || '{}',
        prefix: authParam(auth, 'headerPrefix').trim() || 'Bearer',
      };
    }
    default:
      warnings.push(`${where}: auth type "${auth.type}" not supported yet`);
      return null;
  }
}

const fileFromSrc = (src: string, contentType?: string) => {
  const name = src.slice(Math.max(src.lastIndexOf('/'), src.lastIndexOf('\\')) + 1) || src;
  return { id: newId(), name, path: src, contentType: contentType || guessContentType(name) };
};

// ---------------------------------------------------------------- scripts → captures

const SET_CALL = /(?:pm\.(?:globals|environment|collectionVariables|variables)\.set|postman\.set(?:Environment|Global)Variable)\(\s*(['"`])([^'"`]+)\1\s*,\s*([^;\n]+)/g;
const JSON_ALIAS = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*responseBody\s*\))/g;
const HEADER_GET = /^pm\.response\.headers\.get\(\s*(['"`])([^'"`]+)\1\s*\)$/;

function exprToCapture(variable: string, rawExpr: string, aliases: string[]): Capture | null {
  const expr = rawExpr.trim().replace(/\)\s*$/, '').trim();
  const header = expr.match(HEADER_GET);
  if (header) return { id: newId(), variable, from: 'header', path: header[2] };
  if (expr === 'pm.response.text()' || expr === 'responseBody') return { id: newId(), variable, from: 'body', path: '' };
  for (const base of ['pm.response.json()', ...aliases]) {
    if (!expr.startsWith(base)) continue;
    const rest = expr.slice(base.length);
    if (rest && !/^[.[]/.test(rest)) continue;
    if (!/^[\w$.[\]"' -]*$/.test(rest)) return null;
    try {
      const segs = parsePath(rest);
      return { id: newId(), variable, from: 'body', path: formatPath(segs) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Converts Postman test scripts that save response values into captures. Other script code is reported, not run. */
export function scriptToCaptures(script: string, where: string, warnings: string[]): Capture[] {
  const aliases = [...script.matchAll(JSON_ALIAS)].map((m) => m[1]);
  const out: Capture[] = [];
  let found = 0;
  for (const m of script.matchAll(SET_CALL)) {
    found++;
    const cap = exprToCapture(m[2], m[3], aliases);
    if (cap) out.push(cap);
    else warnings.push(`${where}: could not convert "${m[0].trim().slice(0, 80)}" (set it up under "Save to variables")`);
  }
  if (!found && script.trim()) warnings.push(`${where}: test script skipped (scripts are not supported; only saving values to variables is converted)`);
  return out;
}

const scriptText = (e: PmEvent) => (Array.isArray(e.script?.exec) ? e.script!.exec.join('\n') : String(e.script?.exec ?? ''));

// ---------------------------------------------------------------- import

function convertRequest(name: string, folder: string, item: PmItem, inheritedAuth: Auth | null, warnings: string[]): RequestItem {
  const pm = item.request!;
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
    const fields: FormField[] = (body.formdata ?? []).filter((f) => f && f.key).map((f) => {
      const base = { key: String(f.key), value: f.type === 'file' ? '' : String(f.value ?? ''), enabled: !f.disabled };
      if (f.type !== 'file') return base;
      const src = Array.isArray(f.src) ? f.src[0] : f.src;
      return { ...base, file: src ? fileFromSrc(src, f.contentType) : null };
    });
    req.body = { mode: 'multipart', text: '', form: [], multipart: fields };
    req.headers = req.headers.filter((h) => h.key.toLowerCase() !== 'content-type');
  } else if (body?.mode === 'file') {
    req.body = { mode: 'file', text: '', form: [], file: body.file?.src ? fileFromSrc(body.file.src) : null };
  }

  const own = convertAuth(pm.auth, warnings, name);
  req.auth = own ?? inheritedAuth ?? { type: 'none' };

  for (const ev of item.event ?? []) {
    const text = scriptText(ev);
    if (!text.trim()) continue;
    if (ev.listen === 'test') req.captures = [...(req.captures ?? []), ...scriptToCaptures(text, name, warnings)];
    else warnings.push(`${name}: pre-request script skipped (scripts are not supported)`);
  }
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
  const collection: Collection = { id: newId(), name, folders: [] };

  const walk = (items: PmItem[], folder: string, auth: Auth | null) => {
    for (const it of items) {
      const itemAuth = convertAuth(it.auth, warnings, it.name ?? 'folder') ?? auth;
      if (Array.isArray(it.item)) {
        const path = folder ? `${folder}/${(it.name ?? 'Folder').replace(/\//g, '-')}` : (it.name ?? 'Folder').replace(/\//g, '-');
        collection.folders.push(path);
        walk(it.item, path, itemAuth);
      } else if (it.request) {
        requests.push({ ...convertRequest(it.name ?? 'Request', folder, it, itemAuth, warnings), collectionId: collection.id });
      }
    }
  };
  walk(json.item ?? [], '', convertAuth(json.auth, warnings, 'collection'));

  const vars = kv(json.variable);
  const environment: Environment | null = vars.length
    ? { id: newId(), name: `${name} variables`, variables: vars.map((v) => ({ ...v })) }
    : null;
  return { collection, requests, environment, warnings };
}

interface PmEnvironment { name?: string; values?: PmKV[]; _postman_variable_scope?: string }

const envValues = (e: PmEnvironment): EnvVar[] =>
  (e.values ?? []).filter((v) => v.key).map((v) => ({ key: String(v.key), value: String(v.value ?? ''), enabled: v.disabled !== true && v.enabled !== false, secret: v.type === 'secret' }));

export function isPostmanGlobals(json: unknown): boolean {
  const e = json as PmEnvironment;
  return !!e && Array.isArray(e.values) && e._postman_variable_scope === 'globals';
}

export function importPostmanGlobals(json: unknown): EnvVar[] {
  if (!isPostmanGlobals(json)) throw new Error('Not a Postman globals file');
  return envValues(json as PmEnvironment);
}

export function importPostmanEnvironment(json: unknown): Environment {
  const e = json as PmEnvironment;
  if (!e || !Array.isArray(e.values)) throw new Error('Not a Postman environment file');
  return { id: newId(), name: e.name ?? 'Imported environment', variables: envValues(e) };
}

// ---------------------------------------------------------------- export

const pmKV = (list: KeyValue[]) => list.filter((x) => x.key).map((x) => ({ key: x.key, value: x.value, ...(x.enabled ? {} : { disabled: true }) }));

function pmAuth(a: Auth): PmAuth {
  switch (a.type) {
    case 'bearer': return { type: 'bearer', bearer: [{ key: 'token', value: a.token, type: 'string' }] };
    case 'basic': return { type: 'basic', basic: [{ key: 'username', value: a.username, type: 'string' }, { key: 'password', value: a.password, type: 'string' }] };
    case 'apikey': return { type: 'apikey', apikey: [{ key: 'key', value: a.key, type: 'string' }, { key: 'value', value: a.value, type: 'string' }, { key: 'in', value: a.in, type: 'string' }] };
    case 'digest': return { type: 'digest', digest: [{ key: 'username', value: a.username, type: 'string' }, { key: 'password', value: a.password, type: 'string' }] };
    case 'oauth1':
      return { type: 'oauth1', oauth1: Object.entries({ consumerKey: a.consumerKey, consumerSecret: a.consumerSecret, token: a.token, tokenSecret: a.tokenSecret, signatureMethod: a.signatureMethod, realm: a.realm, version: '1.0', addParamsToHeader: 'true' }).map(([key, value]) => ({ key, value, type: 'string' })) };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: Object.entries({
          grant_type: a.grant === 'password' ? 'password_credentials' : a.grant,
          accessTokenUrl: a.tokenUrl, authUrl: a.authUrl, redirect_uri: a.redirectUri, clientId: a.clientId, clientSecret: a.clientSecret, scope: a.scope,
          username: a.username, password: a.password, client_authentication: a.clientAuth === 'body' ? 'body' : 'header', accessToken: a.token, headerPrefix: a.prefix, addTokenTo: 'header',
        }).map(([key, value]) => ({ key, value, type: 'string' })),
      };
    case 'hawk': return { type: 'hawk', hawk: Object.entries({ authId: a.id, authKey: a.key, algorithm: a.algorithm, extraData: a.ext }).map(([key, value]) => ({ key, value, type: 'string' })) };
    case 'aws': return { type: 'awsv4', awsv4: Object.entries({ accessKey: a.accessKey, secretKey: a.secretKey, region: a.region, service: a.service, sessionToken: a.sessionToken }).map(([key, value]) => ({ key, value, type: 'string' })) };
    case 'jwt':
      return { type: 'jwt', jwt: Object.entries({ algorithm: a.algorithm, [a.algorithm.startsWith('HS') ? 'secret' : 'privateKey']: a.secret, isSecretBase64Encoded: String(a.secretBase64), payload: a.payload, headerPrefix: a.prefix, addTokenTo: 'header' }).map(([key, value]) => ({ key, value, type: 'string' })) };
    default: return { type: 'noauth' };
  }
}

const jsAccessor = (path: string) =>
  parsePath(path)
    .map((s) => (typeof s === 'number' ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`))
    .join('');

/** Captures become a Postman test script, so the token flow keeps working after an export. */
function capturesToScript(caps: Capture[]): string[] {
  if (!caps.length) return [];
  const lines = ['if (pm.response.code >= 200 && pm.response.code < 300) {'];
  for (const c of caps) {
    const value = c.from === 'header' ? `pm.response.headers.get(${JSON.stringify(c.path)})` : c.path ? `pm.response.json()${jsAccessor(c.path)}` : 'pm.response.text()';
    lines.push(`    pm.globals.set(${JSON.stringify(c.variable)}, ${value});`);
  }
  lines.push('}');
  return lines;
}

function pmRequestItem(r: RequestItem) {
  const enabledParams = r.params.filter((p) => p.enabled && p.key);
  const raw = enabledParams.length ? `${r.url}${r.url.includes('?') ? '&' : '?'}${enabledParams.map((p) => `${p.key}=${p.value}`).join('&')}` : r.url;
  const request: Record<string, unknown> = {
    method: r.method,
    header: pmKV(r.headers),
    url: r.params.length ? { raw, query: pmKV(r.params) } : { raw },
  };
  if (r.auth.type !== 'none') request.auth = pmAuth(r.auth);
  if (r.body.mode === 'json') request.body = { mode: 'raw', raw: r.body.text, options: { raw: { language: 'json' } } };
  else if (r.body.mode === 'text') request.body = { mode: 'raw', raw: r.body.text };
  else if (r.body.mode === 'form-urlencoded') request.body = { mode: 'urlencoded', urlencoded: pmKV(r.body.form) };
  else if (r.body.mode === 'multipart') {
    request.body = {
      mode: 'formdata',
      formdata: (r.body.multipart ?? []).filter((f) => f.key).map((f) => ({
        key: f.key,
        ...(f.file === undefined ? { value: f.value, type: 'text' } : { type: 'file', src: f.file?.path ?? f.file?.name ?? null }),
        ...(f.enabled ? {} : { disabled: true }),
      })),
    };
  } else if (r.body.mode === 'file') request.body = { mode: 'file', file: { src: r.body.file?.path ?? r.body.file?.name ?? null } };
  const exec = capturesToScript(r.captures ?? []);
  return { name: r.name, request, ...(exec.length ? { event: [{ listen: 'test', script: { type: 'text/javascript', exec } }] } : {}) };
}

/** Export a collection as Postman Collection v2.1 JSON, so it opens in Postman, Bruno, Insomnia and others. */
export function exportPostmanCollection(c: Collection, allRequests: RequestItem[]): object {
  const requests = allRequests.filter((r) => r.collectionId === c.id);
  const folders = collectionFolders(c, requests);
  const build = (parent: string): object[] => {
    const childFolders = folders.filter((f) => (parent ? f.startsWith(`${parent}/`) && !f.slice(parent.length + 1).includes('/') : !f.includes('/')));
    return [
      ...childFolders.map((f) => ({ name: f.slice(f.lastIndexOf('/') + 1), item: build(f) })),
      ...requests.filter((r) => r.folder === parent).map(pmRequestItem),
    ];
  };
  return { info: { _postman_id: c.id, name: c.name, schema: POSTMAN_SCHEMA }, item: build('') };
}
