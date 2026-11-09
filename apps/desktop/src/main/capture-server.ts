// Local connection the browser extension sends captures to.
// - Listens on 127.0.0.1 only (first free port of 47321–47325).
// - A browser connects once with a 6-digit code shown in the app (5 minutes, single use, 5 tries).
//   It then gets a token; only a hash of the token is kept on disk.
// - Requests must name 127.0.0.1/localhost as Host (blocks DNS rebinding) and, if they carry an
//   Origin, it must be a browser extension: web pages can't talk to this server.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CapturedEntry, CaptureSession, PairedBrowser } from '@restless/core';
import type { CaptureStore } from './capture-store';

export const CAPTURE_PORTS = [47321, 47322, 47323, 47324, 47325];
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_TRIES = 5;
const SOURCES = new Set(['recorder', 'rewind', 'devtools', 'har']);
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[\w-]+$/;

interface StoredBrowser extends PairedBrowser {
  tokenHash: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class CaptureServer {
  port: number | null = null;
  private server: http.Server | null = null;
  private code: { code: string; expiresAt: number; tries: number } | null = null;
  private browsers: StoredBrowser[] = [];

  constructor(
    private store: CaptureStore,
    private browsersFile: string,
    private version: string,
    private onChange: (sessionId: string | null) => void,
  ) {}

  async start() {
    try {
      this.browsers = JSON.parse(await fs.readFile(this.browsersFile, 'utf8'));
    } catch {
      this.browsers = [];
    }
    for (const port of CAPTURE_PORTS) {
      const server = http.createServer((req, res) => void this.handle(req, res, port));
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        this.server = server;
        this.port = port;
        return port;
      }
    }
    return null;
  }

  stop() {
    this.server?.close();
  }

  newCode() {
    if (!this.port) throw new Error('Restless could not open its local connection: ports 47321 to 47325 are all in use.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.code = { code, expiresAt: Date.now() + CODE_TTL_MS, tries: 0 };
    return { code, expiresAt: this.code.expiresAt, port: this.port };
  }

  listBrowsers(): PairedBrowser[] {
    return this.browsers.map(({ tokenHash: _h, ...b }) => b);
  }

  async removeBrowser(id: string) {
    this.browsers = this.browsers.filter((b) => b.id !== id);
    await this.saveBrowsers();
  }

  private async saveBrowsers() {
    await fs.mkdir(path.dirname(this.browsersFile), { recursive: true });
    await fs.writeFile(this.browsersFile, JSON.stringify(this.browsers, null, 2));
  }

  private pair(body: { code?: unknown; name?: unknown }) {
    const given = String(body.code ?? '').replace(/\D/g, '');
    const current = this.code;
    if (!current || current.expiresAt < Date.now()) throw new HttpError(403, 'That code has expired. Make a new one in the desktop app (Capture, then Connect browser).');
    const a = Buffer.from(given.padEnd(6, ' ').slice(0, 6));
    const b = Buffer.from(current.code);
    if (given.length !== 6 || !timingSafeEqual(a, b)) {
      current.tries++;
      if (current.tries >= MAX_TRIES) {
        this.code = null;
        throw new HttpError(429, 'Too many wrong codes. Make a new one in the desktop app.');
      }
      throw new HttpError(403, 'That code is not right. Check the desktop app and try again.');
    }
    this.code = null; // single use
    const token = randomBytes(32).toString('base64url');
    const name = String(body.name ?? 'Browser').slice(0, 60) || 'Browser';
    this.browsers.push({ id: randomUUID(), name, pairedAt: Date.now(), tokenHash: sha256(token) });
    return token;
  }

  private auth(req: http.IncomingMessage): StoredBrowser {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const hash = token ? sha256(token) : '';
    const found = hash ? this.browsers.find((b) => timingSafeEqual(Buffer.from(b.tokenHash), Buffer.from(hash))) : undefined;
    if (!found) throw new HttpError(401, 'This browser is not connected. Connect it again with a new code.');
    return found;
  }

  private async capture(browser: StoredBrowser, body: { session?: CaptureSession; entries?: CapturedEntry[] }) {
    const s = body.session;
    if (!s || typeof s.id !== 'string' || !/^[\w-]{1,80}$/.test(s.id) || typeof s.name !== 'string' || !SOURCES.has(s.source)) {
      throw new HttpError(400, 'Expected { session, entries }');
    }
    const entries = (Array.isArray(body.entries) ? body.entries : []).filter(
      (e) => e && typeof e.id === 'string' && typeof e.url === 'string' && typeof e.method === 'string' && typeof e.startedAt === 'number',
    );
    const session: CaptureSession = {
      id: s.id,
      name: s.name.slice(0, 200),
      source: s.source,
      startedAt: Number(s.startedAt) || Date.now(),
      endedAt: s.endedAt,
      recordingFrom: s.recordingFrom,
      pageUrl: s.pageUrl,
      live: !!s.live,
      device: browser.name,
      entryCount: 0,
    };
    await this.store.put(session, entries);
    browser.lastSeenAt = Date.now();
    void this.saveBrowsers();
    this.onChange(session.id);
    return { received: entries.length };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
    const origin = req.headers.origin;
    const send = (status: number, data: unknown) => {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store' };
      if (origin && EXTENSION_ORIGIN.test(origin)) {
        Object.assign(headers, {
          'access-control-allow-origin': origin,
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-private-network': 'true',
          vary: 'Origin',
        });
      }
      res.writeHead(status, headers);
      res.end(status === 204 ? undefined : JSON.stringify(data));
    };
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Wrong host');
      if (origin && !EXTENSION_ORIGIN.test(origin)) throw new HttpError(403, 'Only the Restless browser extension can connect');
      if (req.method === 'OPTIONS') return send(204, null);

      const url = new URL(req.url ?? '/', `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/v1/hello') return send(200, { app: 'restless', version: this.version });

      if (req.method !== 'POST') throw new HttpError(404, 'Not found');
      const limit = url.pathname === '/v1/capture' ? 200 * 1024 * 1024 : 16 * 1024;
      const body = await readJson(req, limit);
      if (url.pathname === '/v1/pair') {
        const token = this.pair(body as { code?: unknown; name?: unknown });
        await this.saveBrowsers();
        this.onChange(null);
        return send(200, { token });
      }
      if (url.pathname === '/v1/capture') return send(200, await this.capture(this.auth(req), body as { session?: CaptureSession; entries?: CapturedEntry[] }));
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(status, { error: (e as Error).message });
    }
  }
}

async function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}
