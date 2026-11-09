// End-to-end check of the desktop main-process pieces without Electron:
// HTTP engine against a local API, MCP over stdio (clean + polluted) and Streamable HTTP, file storage,
// and the capture store.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { newId, newRequest, normalizeWorkspace, resolveRequest, type McpLogEntry } from '@restless/core';
import { sendHttp } from '../src/main/http-engine';
import { McpManager } from '../src/main/mcp-manager';
import { FileWorkspaceStore } from '../src/main/storage';
import { CaptureStore } from '../src/main/capture-store';

const root = path.resolve(process.argv[2] ?? '../..');
const scripts = path.join(root, 'scripts');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${(e as Error).stack?.split('\n').slice(0, 3).join('\n      ')}`);
  }
};

const api = spawn(process.execPath, [path.join(scripts, 'test-http-server.mjs'), '4545'], { stdio: 'ignore' });
const mcpHttp = spawn(process.execPath, [path.join(scripts, 'test-mcp-server.mjs'), '--http', '3333'], { stdio: 'ignore', cwd: root });
await wait(1200);

try {
  await check('HTTP GET with timings', async () => {
    const res = await sendHttp({ method: 'GET', url: 'http://localhost:4545/users', headers: [] });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body)[0].name, 'Asha');
    assert.ok(res.timings.total > 0 && res.timings.ttfb !== undefined && res.timings.connect !== undefined);
  });

  await check('HTTP POST sends forbidden headers (Cookie, Origin, Host) and JSON body', async () => {
    const item = newRequest({
      method: 'POST',
      url: '{{base}}/echo',
      headers: [
        { key: 'Cookie', value: 'sid=abc', enabled: true },
        { key: 'Origin', value: 'https://evil.example', enabled: true },
      ],
      body: { mode: 'json', text: '{"x":{{n}}}', form: [] },
    });
    const { request } = resolveRequest(item, { base: 'http://localhost:4545', n: '5' });
    const res = await sendHttp(request);
    const echo = JSON.parse(res.body);
    assert.equal(echo.headers.cookie, 'sid=abc');
    assert.equal(echo.headers.origin, 'https://evil.example');
    assert.equal(echo.headers['content-type'], 'application/json');
    assert.equal(echo.body, '{"x":5}');
  });

  await check('HTTP follows redirects', async () => {
    const res = await sendHttp({ method: 'GET', url: 'http://localhost:4545/redirect', headers: [] });
    assert.equal(res.status, 200);
    assert.ok(res.url.endsWith('/users'));
  });

  await check('HTTP connection refused gives a readable error', async () => {
    await assert.rejects(sendHttp({ method: 'GET', url: 'http://localhost:4999/', headers: [] }), /Connection refused/);
  });

  await check('HTTP cancel', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(sendHttp({ method: 'GET', url: 'http://localhost:4545/slow?ms=3000', headers: [] }, { signal: ac.signal }), /cancelled/);
  });

  const logs: McpLogEntry[] = [];
  const mgr = new McpManager((e) => logs.push(e));

  await check('MCP stdio: connect, list, call, resource, prompt, ping', async () => {
    const cfg = { id: 'stdio1', name: 'demo', transport: 'stdio' as const, command: process.execPath, args: [path.join(scripts, 'test-mcp-server.mjs')], cwd: root };
    const info = await mgr.connect(cfg);
    assert.equal(info.serverInfo?.name, 'restless-demo-server');
    assert.ok(info.sessionId.startsWith('stdio1:'));
    assert.ok(info.protocolVersion, 'protocol version captured');
    const cat = await mgr.catalog(info.sessionId);
    assert.deepEqual(cat.tools.map((t) => t.name).sort(), ['add', 'echo', 'fail', 'get_weather', 'slow']);
    assert.equal(cat.resources[0].uri, 'notes://welcome');
    assert.equal(cat.resourceTemplates.length, 1);
    assert.equal(cat.prompts[0].name, 'review_code');
    const add = await mgr.callTool(info.sessionId, 'add', { a: 2, b: 40 });
    assert.deepEqual((add.result as { structuredContent: unknown }).structuredContent, { sum: 42 });
    const fail = await mgr.callTool(info.sessionId, 'fail', {});
    assert.equal(fail.isError, true);
    const r = await mgr.readResource(info.sessionId, 'users://7/profile');
    assert.match(JSON.stringify(r.result), /User 7/);
    const p = await mgr.getPrompt(info.sessionId, 'review_code', { code: 'x=1' });
    assert.match(JSON.stringify(p.result), /x=1/);
    assert.ok((await mgr.ping(info.sessionId)) >= 0);
    assert.ok(logs.some((l) => l.direction === 'out' && l.method === 'tools/call'));
    assert.ok(logs.some((l) => l.direction === 'stderr' && /running on stdio/.test(String(l.message))));
    await mgr.disconnect(info.sessionId);
  });

  await check('MCP stdio: stdout pollution is detected with a hint', async () => {
    const cfg = { id: 'dirty', name: 'dirty', transport: 'stdio' as const, command: process.execPath, args: [path.join(scripts, 'test-mcp-server.mjs'), '--pollute'], cwd: root };
    const info = await mgr.connect(cfg);
    await mgr.callTool(info.sessionId, 'echo', { text: 'hi' }).catch(() => {});
    await wait(200);
    const hint = logs.find((l) => l.sessionId === info.sessionId && l.direction === 'error' && /stderr \(console\.error\)/.test(String(l.message)));
    assert.ok(hint, 'expected a stdout-pollution hint in the log');
    await mgr.disconnect(info.sessionId);
  });

  await check('MCP stdio: missing command gives a clear error', async () => {
    await assert.rejects(mgr.connect({ id: 'nope', name: 'x', transport: 'stdio', command: 'definitely-not-a-real-cmd-xyz' }), /not found|ENOENT/i);
  });

  await check('MCP Streamable HTTP: connect + call', async () => {
    const info = await mgr.connect({ id: 'web', name: 'web', transport: 'http', url: 'http://localhost:3333/mcp', headers: [{ key: 'X-Test', value: '1', enabled: true }] });
    const res = await mgr.callTool(info.sessionId, 'echo', { text: 'over http' });
    assert.match(JSON.stringify(res.result), /over http/);
    await mgr.disconnect(info.sessionId);
  });

  const secrets = { available: false, encrypt: (s: string) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s: string) => Buffer.from(s.slice(6), 'base64').toString() };
  const listFiles = async (dir: string) => (await fs.readdir(dir, { recursive: true })).map((f) => String(f).split(path.sep).join('/'));

  await check('File workspace: collections, folders, globals and captures persist; secrets stay out of the folder', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restless-ws-'));
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'restless-data-'));
    const store = new FileWorkspaceStore(dir, data, secrets);
    let ws = normalizeWorkspace(await store.load());
    const cid = newId();
    ws.collections.push({ id: cid, name: 'Auth API', folders: ['Users/Admin', 'Empty'] });
    const login = newRequest({ collectionId: cid, name: 'Login', folder: '', method: 'POST', url: '{{base}}/login', captures: [{ id: 'c1', variable: 'access_token', from: 'body', path: 'access_token' }] });
    const list = newRequest({ collectionId: cid, name: 'List users', folder: 'Users/../../escape', url: '{{base}}/users' });
    ws.requests.push(login, list);
    ws.globals = [{ key: 'access_token', value: 'TOPSECRET', enabled: true, secret: true }, { key: 'base', value: 'http://x', enabled: true }];
    await store.save(ws);
    const files = await listFiles(dir);
    const cdir = `collections/auth-api--${cid.slice(0, 8)}`;
    assert.ok(files.includes(`${cdir}/collection.yaml`), 'collection.yaml written');
    assert.ok(files.includes(`${cdir}/login--${login.id.slice(0, 8)}.yaml`), 'request at collection top level');
    assert.ok(files.some((f) => f.startsWith(`${cdir}/Users/escape/list-users`)), 'folder traversal blocked');
    const globalsYaml = await fs.readFile(path.join(dir, 'globals.yaml'), 'utf8');
    assert.ok(globalsYaml.includes('base') && !globalsYaml.includes('TOPSECRET'), 'locked global kept out of the workspace');

    ws = normalizeWorkspace(await new FileWorkspaceStore(dir, data, secrets).load());
    assert.deepEqual(ws.collections.map((c) => [c.name, c.folders]), [['Auth API', ['Users/Admin', 'Empty']]]);
    assert.equal(ws.globals.find((g) => g.key === 'access_token')?.value, 'TOPSECRET', 'locked global restored on this machine');
    assert.deepEqual(ws.requests.find((r) => r.name === 'Login')?.captures?.[0], { id: 'c1', variable: 'access_token', from: 'body', path: 'access_token' });

    ws.collections[0].name = 'Identity';
    await store.save(ws);
    let after = await listFiles(dir);
    assert.ok(!after.some((f) => f.startsWith(cdir)), 'old collection folder removed after rename');
    assert.ok(after.includes(`collections/identity--${cid.slice(0, 8)}/collection.yaml`));

    ws = { ...ws, collections: [], requests: [] };
    await store.save(ws);
    after = await listFiles(dir);
    assert.ok(!after.some((f) => f.startsWith('collections/') && f.endsWith('.yaml')), 'deleted collection removed');
  });

  await check('File workspace: 0.1 workspaces (requests/ folder) move into "My collection"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restless-old-'));
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'restless-olddata-'));
    const old = { id: '11111111-2222-3333-4444-555555555555', name: 'Old one', folder: 'Shop', method: 'GET', url: 'http://x', params: [], headers: [], body: { mode: 'none', text: '', form: [] }, auth: { type: 'none' } };
    await fs.mkdir(path.join(dir, 'requests', 'Shop'), { recursive: true });
    await fs.writeFile(path.join(dir, 'requests', 'Shop', 'old-one--11111111.yaml'), JSON.stringify(old));
    await fs.writeFile(path.join(dir, 'restless.yaml'), 'version: 1\nname: Old\n');
    const store = new FileWorkspaceStore(dir, data, secrets);
    const ws = normalizeWorkspace(await store.load());
    assert.equal(ws.collections[0]?.name, 'My collection');
    assert.equal(ws.requests[0].collectionId, ws.collections[0].id);
    assert.equal(ws.requests[0].folder, 'Shop');
    await store.save(ws);
    const files = await listFiles(dir);
    assert.ok(!files.some((f) => f.startsWith('requests')), 'requests/ folder cleaned up');
    assert.ok(files.some((f) => /^collections\/my-collection--[0-9a-f]{8}\/Shop\/old-one--11111111\.yaml$/.test(f)), 'moved into the collection');
  });

  await check('Capture store: sessions and requests survive a restart; same id replaces', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restless-cap-'));
    const store = new CaptureStore(dir);
    const s = { id: newId(), name: 'shop', source: 'browser' as const, startedAt: 2000, live: true, entryCount: 0 };
    const e1 = { id: newId(), sessionId: s.id, startedAt: 1000, method: 'GET', url: 'http://x/a', type: 'fetch', requestHeaders: [], responseHeaders: [] };
    const e2 = { ...e1, id: newId(), startedAt: 3000, url: 'http://x/b' };
    await store.put(s, [e1]);
    await store.put({ ...s, live: false }, [e2, { ...e1, status: 204 }]);
    const again = new CaptureStore(dir);
    const [saved] = await again.list();
    assert.equal(saved.entryCount, 2);
    assert.equal(saved.live, false);
    assert.equal(saved.startedAt, 1000);
    const list = await again.entries(s.id);
    assert.deepEqual(list.map((e) => e.url), ['http://x/a', 'http://x/b']);
    assert.equal(list[0].status, 204);
    await again.delete(s.id);
    assert.equal((await again.list()).length, 0);
    assert.deepEqual(await fs.readdir(dir), []);
  });

} finally {
  api.kill();
  mcpHttp.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
