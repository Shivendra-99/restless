#!/usr/bin/env node
// Tiny local API to try Restless against: node scripts/test-http-server.mjs [port]
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const port = Number(process.argv[2] || 4545);
const tokens = new Set();
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
      res.writeHead(status, { 'content-type': 'application/json', 'x-demo': 'restless', ...extra });
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
    // Login flow to try saving a token into a variable:
    //   POST /auth/token  {"username":"asha","password":"secret"}  -> { data: { access_token } }
    //   GET  /me          Authorization: Bearer <access_token>     -> the user, or 401
    if (url.pathname === '/auth/token' && req.method === 'POST') {
      let creds = {};
      try {
        creds = JSON.parse(body || '{}');
      } catch {
        /* handled below */
      }
      if (creds.username !== 'asha' || creds.password !== 'secret') return json(401, { error: 'Use username "asha" and password "secret"' });
      const token = `tok_${randomBytes(12).toString('hex')}`;
      tokens.add(token);
      return json(200, { token_type: 'Bearer', expires_in: 3600, data: { access_token: token, user_id: 1 } }, { 'x-request-id': randomBytes(4).toString('hex') });
    }
    if (url.pathname === '/me') {
      const auth = String(req.headers.authorization ?? '');
      if (!tokens.has(auth.replace(/^Bearer\s+/i, ''))) return json(401, { error: 'Missing or unknown token. Call POST /auth/token first.' });
      return json(200, users[0]);
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
    json(404, { error: 'Not found', try: ['/users', 'POST /auth/token', '/me', '/echo', '/slow?ms=1500', '/redirect'] });
  })
  .listen(port, () => console.error(`Demo API on http://localhost:${port}`));
