import { describe, expect, it } from 'vitest';
import {
  buildUrl,
  exampleFromSchema,
  importPostmanCollection,
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
    expect(list.folder).toBe('Shop/Orders');
    expect(list.url).toBe('{{base}}/orders');
    expect(list.params).toEqual([{ key: 'status', value: 'open', enabled: true }]);
    expect(list.headers[0].enabled).toBe(false);
    expect(list.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(create.auth).toEqual({ type: 'none' });
    expect(create.body.mode).toBe('json');
    expect(res.environment?.variables[0]).toMatchObject({ key: 'base', value: 'https://shop.test' });
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
