// Desktop HTTP engine. Uses node:http/https directly so we get what a browser can't give:
// no CORS, any header (Cookie, Host, Origin…), and per-phase timings (DNS, connect, TLS, TTFB).
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileContentType, type FileRef, type HttpResponse, type HttpTimings, type ResolvedRequest } from '@restless/core';

const MAX_BODY = 50 * 1024 * 1024;
const MAX_REDIRECTS = 10;

export interface EngineOptions {
  signal?: AbortSignal;
  /** Skip TLS certificate checks (self-signed dev servers). Off by default. */
  insecure?: boolean;
  timeoutMs?: number;
}

function decompress(buf: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
    if (enc === 'zstd' && z.zstdDecompressSync) return z.zstdDecompressSync(buf);
  } catch {
    /* fall through with the raw bytes */
  }
  return buf;
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|[\w.+-]*\+(json|xml)))|charset=/i;

async function readUpload(f: FileRef): Promise<Buffer> {
  if (!f.path) throw new Error(`Choose the file "${f.name}" again: where it is on this computer isn't known`);
  try {
    return await fs.readFile(f.path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? `The file to upload is no longer there: ${f.path}` : `Could not read the file to upload (${code ?? (e as Error).message}): ${f.path}`);
  }
}

// Names and file names go inside quotes in a part's header, so quotes and line breaks are escaped the way browsers do it.
const partName = (s: string) => s.replace(/\r?\n/g, '%0D%0A').replace(/"/g, '%22');

/** Bytes for a file or multipart body, read fresh from disk. Undefined when the body is plain text (or absent). */
export async function buildPayload(r: ResolvedRequest): Promise<{ bytes: Buffer; contentType?: string } | undefined> {
  if (r.file) return { bytes: await readUpload(r.file) };
  if (!r.multipart) return undefined;
  const boundary = `----RestlessFormBoundary${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of r.multipart) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${partName(p.name)}"`;
    if ('file' in p) {
      head += `; filename="${partName(p.file.name)}"\r\nContent-Type: ${fileContentType(p.file)}`;
      chunks.push(Buffer.from(`${head}\r\n\r\n`, 'utf8'), await readUpload(p.file), Buffer.from('\r\n'));
    } else chunks.push(Buffer.from(`${head}\r\n\r\n${p.value}\r\n`, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { bytes: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function single(r: ResolvedRequest, opts: EngineOptions, payload?: Buffer): Promise<{ res: HttpResponse; location?: string }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      reject(new Error(`Invalid URL: ${r.url}`));
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error(`Unsupported protocol ${url.protocol}`));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;

    // Duplicate header names are allowed (e.g. two Set-Cookie style headers on purpose).
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of r.headers) {
      const existing = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase());
      if (existing) headers[existing] = ([] as string[]).concat(headers[existing], v);
      else headers[k] = v;
    }
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) headers['User-Agent'] = 'Restless/0.1';
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers['Accept'] = '*/*';
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept-encoding')) headers['Accept-Encoding'] = 'gzip, deflate, br';

    const body = payload ?? (r.body !== undefined ? Buffer.from(r.body, 'utf8') : undefined);
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) headers['Content-Length'] = String(body.length);

    const t0 = performance.now();
    const marks: { lookup?: number; connect?: number; secure?: number; firstByte?: number; end?: number } = {};

    const req = mod.request(
      url,
      {
        method: r.method,
        headers,
        // A fresh socket per request so every phase is measured (like Postman's timeline).
        agent: false,
        rejectUnauthorized: !opts.insecure,
        signal: opts.signal,
      },
      (res) => {
        marks.firstByte = performance.now();
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy(new Error(`Response is larger than ${MAX_BODY / 1024 / 1024} MB; stopped reading`));
            return;
          }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => {
          marks.end = performance.now();
          const raw = Buffer.concat(chunks);
          const decoded = decompress(raw, res.headers['content-encoding'] as string | undefined);
          const ct = String(res.headers['content-type'] ?? '');
          const isText = !ct || TEXTUAL.test(ct);
          const pairs: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);

          const timings: HttpTimings = { total: marks.end - t0 };
          const tcpStart = marks.lookup ?? t0;
          if (marks.lookup !== undefined) timings.dns = marks.lookup - t0;
          if (marks.connect !== undefined) timings.connect = marks.connect - tcpStart;
          if (marks.secure !== undefined && marks.connect !== undefined) timings.tls = marks.secure - marks.connect;
          const ready = marks.secure ?? marks.connect ?? t0;
          timings.ttfb = marks.firstByte! - ready;
          timings.download = marks.end - marks.firstByte!;

          resolve({
            res: {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: pairs,
              body: isText ? decoded.toString('utf8') : `[binary ${ct || 'data'}, ${decoded.length} bytes]`,
              size: raw.length,
              timings,
              url: r.url,
            },
            location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
          });
        });
      },
    );

    req.on('socket', (socket) => {
      socket.on('lookup', () => (marks.lookup = performance.now()));
      socket.on('connect', () => (marks.connect = performance.now()));
      socket.on('secureConnect', () => (marks.secure = performance.now()));
    });
    req.setTimeout(opts.timeoutMs ?? r.timeoutMs ?? 60_000, () => req.destroy(new Error(`No response within ${Math.round((opts.timeoutMs ?? r.timeoutMs ?? 60_000) / 1000)} s`)));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.name === 'AbortError') reject(new Error('Request cancelled'));
      else if (e.code === 'ECONNREFUSED') reject(new Error(`Connection refused by ${url.host}. Is the server running?`));
      else if (e.code === 'ENOTFOUND') reject(new Error(`Could not resolve host ${url.hostname}`));
      else if (e.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code)) reject(new Error(`TLS certificate problem (${e.code}): ${e.message}`));
      else reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Send a request, following redirects the way browsers do (303 and 301/302 on POST become GET). */
export async function sendHttp(r: ResolvedRequest, opts: EngineOptions = {}): Promise<HttpResponse> {
  let current = r;
  let payload: Buffer | undefined;
  const built = await buildPayload(r);
  if (built) {
    payload = built.bytes;
    if (built.contentType) current = { ...r, headers: [...r.headers.filter(([k]) => k.toLowerCase() !== 'content-type'), ['Content-Type', built.contentType]] };
  }
  const started = performance.now();
  for (let hop = 0; ; hop++) {
    const { res, location } = await single(current, opts, payload);
    const redirect = location && [301, 302, 303, 307, 308].includes(res.status) && current.followRedirects !== false;
    if (!redirect || hop >= MAX_REDIRECTS) {
      if (hop > 0) res.timings = { ...res.timings, total: performance.now() - started };
      return res;
    }
    const next = new URL(location!, current.url).toString();
    const toGet = res.status === 303 || ((res.status === 301 || res.status === 302) && current.method === 'POST');
    const crossOrigin = new URL(next).origin !== new URL(current.url).origin;
    if (toGet) payload = undefined;
    current = {
      ...current,
      url: next,
      method: toGet ? 'GET' : current.method,
      body: toGet ? undefined : current.body,
      headers: current.headers.filter(([k]) => {
        const l = k.toLowerCase();
        if (toGet && (l === 'content-type' || l === 'content-length')) return false;
        if (crossOrigin && (l === 'authorization' || l === 'cookie')) return false; // don't leak credentials to another host
        return true;
      }),
    };
  }
}
