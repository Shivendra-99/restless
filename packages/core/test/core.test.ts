import { describe, expect, it } from 'vitest';
import {
  addFolder,
  buildUrl,
  collectionFolders,
  deleteFolder,
  emptyWorkspace,
  exampleFromSchema,
  exportPostmanCollection,
  extractCapture,
  formatPath,
  getAtPath,
  importPostmanCollection,
  importPostmanGlobals,
  normalizeWorkspace,
  parsePath,
  renameFolder,
  resolveVariables,
  runCaptures,
  scriptToCaptures,
  setGlobal,
  suggestVariableName,
  usedVariables,
  variableMap,
  type HttpResponse,
  interpolate,
  lintTools,
  missingRequired,
  newRequest,
  parseCurl,
  resolveRequest,
  shellSplit,
  toCurl,
} from '../src';

describe('variables', () => {
  it('interpolates and reports missing', () => {
    const missing = new Set<string>();
    expect(interpolate('{{base}}/u/{{ id }}/{{nope}}', { base: 'http://x', id: '7' }, missing)).toBe('http://x/u/7/{{nope}}');
    expect([...missing]).toEqual(['nope']);
  });
  it('supports dynamic vars', () => {
    expect(interpolate('{{$uuid}}', {})).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('buildUrl appends params correctly', () => {
    expect(buildUrl('http://a/b?x=1#h', [{ key: 'q', value: 'a b', enabled: true }, { key: 'off', value: '1', enabled: false }])).toBe('http://a/b?x=1&q=a%20b#h');
  });
});

describe('resolveRequest', () => {
  it('applies auth, body and params', () => {
    const item = newRequest({
      method: 'POST',
      url: '{{base}}/items',
      params: [{ key: 'page', value: '{{p}}', enabled: true }],
      headers: [{ key: 'X-Trace', value: 't', enabled: true }],
      body: { mode: 'json', text: '{"a":"{{p}}"}', form: [] },
      auth: { type: 'bearer', token: '{{tok}}' },
    });
    const { request, missing } = resolveRequest(item, { base: 'https://api.test', p: '2', tok: 'abc' });
    expect(missing).toEqual([]);
    expect(request.url).toBe('https://api.test/items?page=2');
    expect(request.body).toBe('{"a":"2"}');
    expect(request.headers).toContainEqual(['Authorization', 'Bearer abc']);
    expect(request.headers).toContainEqual(['Content-Type', 'application/json']);
  });
  it('basic auth is utf-8 safe and GET drops body', () => {
    const { request } = resolveRequest(newRequest({ url: 'localhost:3000', auth: { type: 'basic', username: 'ü', password: 'p' }, body: { mode: 'text', text: 'x', form: [] } }), {});
    expect(request.url).toBe('http://localhost:3000');
    expect(request.body).toBeUndefined();
    expect(request.headers[0][1]).toBe('Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode('ü:p'))));
  });
});

describe('cURL', () => {
  it('splits shell words', () => {
    expect(shellSplit(`curl -H 'a: b' "x \\"y\\"" \\\n -d $'z'`)).toEqual(['curl', '-H', 'a: b', 'x "y"', '-d', 'z']);
  });
  it('parses a Chrome "copy as cURL" command', () => {
    const cmd = `curl 'https://api.example.com/v1/users?limit=5' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer xyz' \\
  -H 'content-type: application/json' \\
  -b 'sid=123' \\
  --data-raw '{"name":"Shiv"}' \\
  --compressed`;
    const { request, warnings } = parseCurl(cmd);
    expect(warnings).toEqual([]);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.example.com/v1/users?limit=5');
    expect(request.body.mode).toBe('json');
    expect(JSON.parse(request.body.text)).toEqual({ name: 'Shiv' });
    expect(request.headers.map((h) => h.key)).toEqual(['accept', 'authorization', 'Cookie']);
  });
  it('parses form data, -u and -XPUT', () => {
    const { request } = parseCurl(`curl -XPUT -u admin:secret https://x.test/f -d a=1 -d 'b=hello+world'`);
    expect(request.method).toBe('PUT');
    expect(request.auth).toEqual({ type: 'basic', username: 'admin', password: 'secret' });
    expect(request.body.form).toEqual([{ key: 'a', value: '1', enabled: true }, { key: 'b', value: 'hello world', enabled: true }]);
  });
  it('round-trips through toCurl', () => {
    const { request } = resolveRequest(newRequest({ method: 'POST', url: 'https://x.test/a', body: { mode: 'json', text: `{"q":"it's"}`, form: [] } }), {});
    const back = parseCurl(toCurl(request)).request;
    expect(back.method).toBe('POST');
    expect(JSON.parse(back.body.text)).toEqual({ q: "it's" });
  });
});

describe('Postman import', () => {
  it('imports folders, query, bodies, inherited auth and variables', () => {
    const col = {
      info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
      variable: [{ key: 'base', value: 'https://shop.test' }],
      item: [
        {
          name: 'Orders',
          item: [
            {
              name: 'List orders',
              request: { method: 'GET', url: { raw: '{{base}}/orders?status=open', query: [{ key: 'status', value: 'open' }] }, header: [{ key: 'X-A', value: '1', disabled: true }] },
            },
            {
              name: 'Create order',
              request: { method: 'POST', url: '{{base}}/orders', body: { mode: 'raw', raw: '{"sku":1}', options: { raw: { language: 'json' } } }, auth: { type: 'noauth' } },
            },
          ],
        },
      ],
    };
    const res = importPostmanCollection(col);
    expect(res.requests).toHaveLength(2);
    const [list, create] = res.requests;
    expect(res.collection.name).toBe('Shop');
    expect(res.collection.folders).toEqual(['Orders']);
    expect(list.collectionId).toBe(res.collection.id);
    expect(list.folder).toBe('Orders');
    expect(list.url).toBe('{{base}}/orders');
    expect(list.params).toEqual([{ key: 'status', value: 'open', enabled: true }]);
    expect(list.headers[0].enabled).toBe(false);
    expect(list.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(create.auth).toEqual({ type: 'none' });
    expect(create.body.mode).toBe('json');
    expect(res.environment?.variables[0]).toMatchObject({ key: 'base', value: 'https://shop.test' });
  });
});

const res = (body: unknown, status = 200, headers: [string, string][] = []): HttpResponse => ({
  status,
  statusText: '',
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  size: 0,
  timings: { total: 1 },
  url: 'http://x',
});

describe('collections and folders', () => {
  it('moves old requests without a collection into "My collection"', () => {
    const ws = normalizeWorkspace({ requests: [newRequest({ name: 'a', folder: ' x / y ' })] } as never);
    expect(ws.collections).toHaveLength(1);
    expect(ws.collections[0].name).toBe('My collection');
    expect(ws.requests[0].collectionId).toBe(ws.collections[0].id);
    expect(ws.requests[0].folder).toBe('x/y');
    expect(ws.globals).toEqual([]);
  });
  it('adds, renames and deletes folders with their requests', () => {
    let ws = normalizeWorkspace({ ...emptyWorkspace(), collections: [{ id: 'c', name: 'API', folders: [] }] });
    ws = addFolder(ws, 'c', '', 'Users');
    ws = addFolder(ws, 'c', 'Users', 'Admin');
    ws.requests.push(newRequest({ collectionId: 'c', folder: 'Users/Admin', name: 'r1' }), newRequest({ collectionId: 'c', folder: '', name: 'r2' }));
    expect(collectionFolders(ws.collections[0], ws.requests)).toEqual(['Users', 'Users/Admin']);
    ws = renameFolder(ws, 'c', 'Users', 'People');
    expect(ws.requests[0].folder).toBe('People/Admin');
    expect(collectionFolders(ws.collections[0], ws.requests)).toEqual(['People', 'People/Admin']);
    ws = deleteFolder(ws, 'c', 'People');
    expect(ws.requests.map((r) => r.name)).toEqual(['r2']);
    expect(ws.collections[0].folders).toEqual([]);
  });
});

describe('global variables and captures', () => {
  it('environment overrides globals; usedVariables finds names', () => {
    const ws = normalizeWorkspace({
      ...emptyWorkspace(),
      globals: [{ key: 'token', value: 'g', enabled: true }, { key: 'base', value: 'http://g', enabled: true }],
      environments: [{ id: 'e', name: 'Local', variables: [{ key: 'base', value: 'http://local', enabled: true }] }],
      activeEnvironmentId: 'e',
    });
    expect(variableMap(ws)).toEqual({ token: 'g', base: 'http://local' });
    expect(resolveVariables(ws).get('base')?.scope).toBe('environment');
    const item = newRequest({ url: '{{base}}/x', auth: { type: 'bearer', token: '{{token}}' }, headers: [{ key: 'X', value: '{{$uuid}} {{trace}}', enabled: true }] });
    expect(usedVariables(item)).toEqual(['base', 'trace', 'token']);
  });
  it('setGlobal creates secret globals and updates existing ones', () => {
    let g = setGlobal([], 'access token', 'a');
    expect(g).toEqual([{ key: 'access_token', value: 'a', enabled: true, secret: true }]);
    g = setGlobal([{ key: 'access_token', value: 'old', enabled: false, secret: false }], 'access_token', 'new');
    expect(g).toEqual([{ key: 'access_token', value: 'new', enabled: true, secret: false }]);
  });
  it('JSON paths round-trip', () => {
    const segs = ['data', 'items', 0, 'weird key', 'id-x'];
    const p = formatPath(segs);
    expect(p).toBe('data.items[0]["weird key"].id-x');
    expect(parsePath(p)).toEqual(segs);
    expect(parsePath('$.a[1]')).toEqual(['a', 1]);
    expect(getAtPath({ a: [{ b: 2 }] }, ['a', 0, 'b'])).toBe(2);
    expect(suggestVariableName(['data', 'access_token'])).toBe('access_token');
    expect(suggestVariableName(['items', 0])).toBe('items');
  });
  it('extracts from body and headers', () => {
    const r = res({ data: { access_token: 'abc', expires: 3600, user: { id: 7 } } }, 200, [['X-Request-Id', 'rq1']]);
    expect(extractCapture({ id: '1', variable: 't', from: 'body', path: 'data.access_token' }, r)).toEqual({ ok: true, value: 'abc' });
    expect(extractCapture({ id: '1', variable: 't', from: 'body', path: 'data.user' }, r)).toEqual({ ok: true, value: '{"id":7}' });
    expect(extractCapture({ id: '1', variable: 't', from: 'header', path: 'x-request-id' }, r)).toEqual({ ok: true, value: 'rq1' });
    expect(extractCapture({ id: '1', variable: 't', from: 'body', path: 'nope' }, r).ok).toBe(false);
  });
  it('runCaptures updates globals only on 2xx', () => {
    const item = newRequest({ captures: [{ id: '1', variable: 'access_token', from: 'body', path: 'access_token' }] });
    const ok = runCaptures(item, res({ access_token: 'T1' }), [{ key: 'access_token', value: 'T0', enabled: true, secret: true }]);
    expect(ok.updated).toEqual([{ variable: 'access_token', value: 'T1' }]);
    expect(ok.globals[0].value).toBe('T1');
    const bad = runCaptures(item, res({ error: 'expired' }, 401), ok.globals);
    expect(bad.updated).toEqual([]);
    expect(bad.globals[0].value).toBe('T1');
    expect(bad.missed[0].reason).toMatch(/401/);
  });
});

describe('Postman scripts and export', () => {
  it('converts common token-saving test scripts into captures', () => {
    const warnings: string[] = [];
    const script = [
      'var jsonData = pm.response.json();',
      'pm.environment.set("token", jsonData.data.access_token);',
      "pm.globals.set('refresh', pm.response.json().refresh_token);",
      'postman.setEnvironmentVariable("rid", pm.response.headers.get("X-Request-Id"));',
      'pm.test("ok", () => pm.response.to.have.status(200));',
      'pm.environment.set("calc", Date.now() + 5);',
    ].join('\n');
    const caps = scriptToCaptures(script, 'Login', warnings);
    expect(caps.map(({ variable, from, path }) => ({ variable, from, path }))).toEqual([
      { variable: 'token', from: 'body', path: 'data.access_token' },
      { variable: 'refresh', from: 'body', path: 'refresh_token' },
      { variable: 'rid', from: 'header', path: 'X-Request-Id' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/calc/);
  });
  it('exports v2.1 that imports back the same, including captures', () => {
    const c = { id: 'c1', name: 'Auth API', folders: ['Empty'] };
    const login = newRequest({
      collectionId: 'c1',
      folder: 'Auth',
      name: 'Login',
      method: 'POST',
      url: '{{base}}/login',
      params: [{ key: 'v', value: '2', enabled: true }],
      body: { mode: 'json', text: '{"user":"a"}', form: [] },
      captures: [{ id: 'x', variable: 'access_token', from: 'body', path: 'data["access-token"]' }],
    });
    const me = newRequest({ collectionId: 'c1', name: 'Me', url: '{{base}}/me', auth: { type: 'bearer', token: '{{access_token}}' } });
    const json = JSON.parse(JSON.stringify(exportPostmanCollection(c, [login, me, newRequest({ collectionId: 'other' })])));
    expect(json.info.schema).toMatch(/v2.1.0/);
    expect(json.item.map((i: { name: string }) => i.name)).toEqual(['Auth', 'Empty', 'Me']);
    const back = importPostmanCollection(json);
    expect(back.warnings).toEqual([]);
    expect(back.collection.folders).toEqual(['Auth', 'Empty']);
    const [l, m] = back.requests;
    expect(l).toMatchObject({ name: 'Login', folder: 'Auth', method: 'POST', url: '{{base}}/login', params: [{ key: 'v', value: '2', enabled: true }] });
    expect(l.body).toEqual(login.body);
    expect(l.captures?.map(({ variable, from }) => ({ variable, from }))).toEqual([{ variable: 'access_token', from: 'body' }]);
    expect(parsePath(l.captures![0].path)).toEqual(['data', 'access-token']);
    expect(m.auth).toEqual({ type: 'bearer', token: '{{access_token}}' });
  });
  it('imports Postman globals', () => {
    expect(importPostmanGlobals({ _postman_variable_scope: 'globals', values: [{ key: 'a', value: '1', enabled: true }] })).toEqual([{ key: 'a', value: '1', enabled: true, secret: false }]);
  });
});

describe('MCP lint + schema helpers', () => {
  const tools = [
    { name: 'search', description: 'Search the product catalog by keyword and filters', inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'query' }, limit: { type: 'integer' } }, required: ['q', 'missing'] } },
    { name: 'search', description: '', inputSchema: { type: 'object' } },
    { name: 'bad name!', description: 'short', inputSchema: { type: 'string' } },
  ];
  it('finds real problems', () => {
    const r = lintTools(tools);
    const msgs = r.issues.map((i) => `${i.level}:${i.tool}:${i.message}`);
    expect(msgs.some((m) => m.startsWith('error:search:Tool name is used 2 times'))).toBe(true);
    expect(msgs.some((m) => m.includes('Required param "missing"'))).toBe(true);
    expect(msgs.some((m) => m.includes('Param "limit" has no description'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('warn:bad name!:Name'))).toBe(true);
    expect(msgs.some((m) => m.includes('inputSchema.type must be "object"'))).toBe(true);
    expect(r.approxTokens).toBeGreaterThan(10);
  });
  it('builds examples and checks required', () => {
    expect(exampleFromSchema(tools[0].inputSchema)).toEqual({ q: '', limit: 0 });
    expect(missingRequired(tools[0].inputSchema, { q: 'x' })).toEqual(['missing']);
  });
});
