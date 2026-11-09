#!/usr/bin/env node
// Tiny local API to try Probe against: node scripts/test-http-server.mjs [port]
import http from 'node:http';

const port = Number(process.argv[2] || 4545);
const users = [
  { id: 1, name: 'Asha', role: 'admin' },
  { id: 2, name: 'Ravi', role: 'dev' },
];

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (status, data, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-demo': 'probe', ...extra });
      res.end(JSON.stringify(data, null, 2));
    };
    if (url.pathname === '/users' && req.method === 'GET') return json(200, users);
    if (url.pathname === '/users' && req.method === 'POST') {
      try {
        const u = JSON.parse(body);
        const created = { id: users.length + 1, ...u };
        users.push(created);
        return json(201, created);
      } catch {
        return json(400, { error: 'Body must be JSON' });
      }
    }
    if (url.pathname === '/echo') {
      return json(200, { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    }
    if (url.pathname === '/slow') {
      await new Promise((r) => setTimeout(r, Number(url.searchParams.get('ms') || 1500)));
      return json(200, { ok: true });
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/users' });
      return res.end();
    }
    json(404, { error: 'Not found', try: ['/users', '/echo', '/slow?ms=1500', '/redirect'] });
  })
  .listen(port, () => console.error(`Demo API on http://localhost:${port}`));
