// End-to-end check of the desktop main-process pieces without Electron:
// HTTP engine against a local API, MCP over stdio (clean + polluted) and Streamable HTTP, and file storage.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { newId, newRequest, resolveRequest, type McpLogEntry } from '@probe/core';
import { sendHttp } from '../src/main/http-engine';
import { McpManager } from '../src/main/mcp-manager';
import { FileWorkspaceStore } from '../src/main/storage';

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
    assert.equal(info.serverInfo?.name, 'probe-demo-server');
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

  await check('File workspace: save, reload, secrets kept out of the folder, stale files removed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-ws-'));
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-data-'));
    const secrets = { available: false, encrypt: (s: string) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s: string) => Buffer.from(s.slice(6), 'base64').toString() };
    const store = new FileWorkspaceStore(dir, data, secrets);
    const ws = await store.load();
    const envId = newId();
    const r1 = newRequest({ name: 'List users', folder: 'Shop/../../escape', url: 'http://x/users' });
    ws.requests.push(r1);
    ws.environments.push({ id: envId, name: 'Local', variables: [{ key: 'token', value: 'TOPSECRET', enabled: true, secret: true }, { key: 'base', value: 'http://x', enabled: true }] });
    ws.activeEnvironmentId = envId;
    await store.save(ws);
    const files = (await fs.readdir(dir, { recursive: true })).map(String);
    assert.ok(files.some((f) => f.includes(`list-users--${r1.id.slice(0, 8)}.yaml`)));
    assert.ok(!files.some((f) => f.includes('escape') && !f.startsWith('requests')), 'folder traversal blocked');
    const envFile = files.find((f) => f.startsWith('environments') && f.endsWith('.yaml'))!;
    assert.ok(!(await fs.readFile(path.join(dir, envFile), 'utf8')).includes('TOPSECRET'), 'secret not in workspace');
    const back = await new FileWorkspaceStore(dir, data, secrets).load();
    assert.equal(back.requests[0].name, 'List users');
    assert.equal(back.environments[0].variables.find((v) => v.key === 'token')?.value, 'TOPSECRET');
    back.requests[0].name = 'Renamed';
    await store.save(back);
    const after = (await fs.readdir(path.join(dir, 'requests'), { recursive: true })).map(String);
    assert.equal(after.filter((f) => f.endsWith('.yaml')).length, 1, 'old file removed after rename');
  });
} finally {
  api.kill();
  mcpHttp.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
