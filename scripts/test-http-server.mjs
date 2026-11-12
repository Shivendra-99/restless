#!/usr/bin/env node
// Tiny local API to try Restless against: node scripts/test-http-server.mjs [port]
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

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
    const raw = Buffer.concat(chunks);
    const body = raw.toString();
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
    // File uploads: POST /upload with a multipart form or a file as the body. Answers what arrived, with sizes and SHA-256.
    if (url.pathname === '/upload') {
      const type = String(req.headers['content-type'] ?? '');
      const sha = (b) => createHash('sha256').update(b).digest('hex');
      const boundary = type.match(/boundary=("?)([^";]+)\1/)?.[2];
      if (!boundary) return json(200, { contentType: type, size: raw.length, sha256: sha(raw) });
      const parts = [];
      const mark = Buffer.from(`--${boundary}`);
      for (let at = raw.indexOf(mark); at >= 0; ) {
        const next = raw.indexOf(mark, at + mark.length);
        if (next < 0) break;
        const part = raw.subarray(at + mark.length + 2, next - 2);
        const split = part.indexOf('\r\n\r\n');
        const head = part.subarray(0, split).toString();
        const data = part.subarray(split + 4);
        const filename = head.match(/filename="([^"]*)"/)?.[1];
        parts.push({
          name: head.match(/name="([^"]*)"/)?.[1],
          ...(filename !== undefined ? { filename, contentType: head.match(/content-type:\s*(.+)/i)?.[1], size: data.length, sha256: sha(data) } : { value: data.toString() }),
        });
        at = next;
      }
      return json(200, { parts });
    }
    // Digest auth: GET /digest with username "asha" and password "secret".
    if (url.pathname === '/digest') {
      const md5 = (x) => createHash('md5').update(x).digest('hex');
      const fields = Object.fromEntries([...String(req.headers.authorization ?? '').matchAll(/([a-z]+)="?([^",]+)"?/gi)].map((m) => [m[1], m[2]]));
      const expected = md5(`${md5('asha:restless:secret')}:${fields.nonce}:${fields.nc}:${fields.cnonce}:auth:${md5(`${req.method}:${fields.uri}`)}`);
      if (fields.response && fields.response === expected && fields.uri === url.pathname + url.search) return json(200, { ok: true, user: 'asha' });
      return json(401, { error: 'Digest auth needed: username "asha", password "secret"' }, { 'www-authenticate': `Digest realm="restless", qop="auth", nonce="${randomBytes(12).toString('hex')}", opaque="demo"` });
    }
    // OAuth 2.0 token URL: client id "demo-app", secret "demo-secret" (client credentials), or the password grant with asha / secret.
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      const basic = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic\s+/i, ''), 'base64').toString().split(':');
      const id = form.get('client_id') ?? basic[0];
      const secret = form.get('client_secret') ?? basic[1];
      if (id !== 'demo-app' || secret !== 'demo-secret') return json(401, { error: 'invalid_client', error_description: 'Use client id "demo-app" and secret "demo-secret"' });
      if (form.get('grant_type') === 'password' && (form.get('username') !== 'asha' || form.get('password') !== 'secret')) return json(400, { error: 'invalid_grant', error_description: 'Use username "asha" and password "secret"' });
      const token = `tok_${randomBytes(12).toString('hex')}`;
      tokens.add(token);
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: form.get('scope') ?? '' });
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
    json(404, { error: 'Not found', try: ['/users', 'POST /auth/token', '/me', '/echo', 'POST /upload', '/digest', 'POST /oauth/token', '/slow?ms=1500', '/redirect'] });
  })
  .listen(port, () => console.error(`Demo API on http://localhost:${port}`));
