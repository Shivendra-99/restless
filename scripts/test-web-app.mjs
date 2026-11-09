#!/usr/bin/env node
// A tiny web app that calls its own API, to try network capture against:
//   node scripts/test-web-app.mjs [port]   then open http://localhost:5555 and record that tab.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const port = Number(process.argv[2] || 5555);
const tokens = new Set();
const products = [
  { id: 'p1', name: 'Filter coffee', price: 120 },
  { id: 'p2', name: 'Masala chai', price: 60 },
  { id: 'p3', name: 'Samosa', price: 40 },
];
const cart = [];

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Corner Café</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #222; }
  button { font: inherit; padding: 6px 12px; margin: 0 6px 6px 0; }
  pre { background: #f3f3f3; padding: 12px; overflow: auto; }
</style></head>
<body>
  <h1>Corner Café</h1>
  <p>A small app that talks to its API. Record this tab in Restless, then use the buttons.</p>
  <div>
    <button id="login">Log in</button>
    <button id="products">Load menu</button>
    <button id="add">Add chai to cart</button>
    <button id="broken">Call a broken endpoint</button>
  </div>
  <pre id="out">…</pre>
<script>
  let token = null;
  const out = (x) => (document.getElementById('out').textContent = typeof x === 'string' ? x : JSON.stringify(x, null, 2));
  const api = async (path, opts = {}) => {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } });
    const data = await res.json().catch(() => null);
    out({ status: res.status, data });
    return data;
  };
  document.getElementById('login').onclick = async () => { const d = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: 'asha', password: 'secret' }) }); token = d && d.token; };
  document.getElementById('products').onclick = () => api('/api/products?limit=10');
  document.getElementById('add').onclick = () => api('/api/cart', { method: 'POST', body: JSON.stringify({ productId: 'p2', qty: 2 }) });
  document.getElementById('broken').onclick = () => api('/api/reports/today');
  api('/api/config');
</script>
</body></html>`;

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (status, data, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
      res.end(JSON.stringify(data));
    };
    const authed = () => tokens.has((req.headers.authorization || '').replace(/^Bearer /, ''));

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (url.pathname === '/api/config') return json(200, { currency: 'INR', open: true, version: '1.4.2' });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      let creds = {};
      try {
        creds = JSON.parse(body);
      } catch {}
      if (creds.username !== 'asha' || creds.password !== 'secret') return json(401, { error: 'Wrong username or password' });
      const token = randomBytes(12).toString('hex');
      tokens.add(token);
      return json(200, { token, user: { id: 1, name: 'Asha' } }, { 'set-cookie': `session=${token}; HttpOnly; Path=/` });
    }
    if (url.pathname === '/api/products') return json(200, { items: products.slice(0, Number(url.searchParams.get('limit') || 10)) });
    if (url.pathname === '/api/cart' && req.method === 'POST') {
      if (!authed()) return json(401, { error: 'Log in first' });
      let item = {};
      try {
        item = JSON.parse(body);
      } catch {}
      cart.push(item);
      return json(201, { cart });
    }
    if (url.pathname === '/api/reports/today') return json(500, { error: 'Report service is down' });
    json(404, { error: 'Not found' });
  })
  .listen(port, '127.0.0.1', () => console.log(`Demo web app on http://localhost:${port}`));
