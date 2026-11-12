// Auth that has to be computed: signed tokens and signatures (JWT, OAuth 1.0, Hawk, AWS), the Digest
// challenge-response, and getting OAuth 2.0 tokens. Uses Web Crypto, so it runs the same in Node, Electron and browsers.
import type { Auth, HttpResponse, RequestItem, ResolvedRequest } from './types';
import { resolveRequest, type VarMap } from './variables';

type Hash = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
type AuthOf<T extends Auth['type']> = Extract<Auth, { type: T }>;

const utf8 = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function base64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
const base64url = (bytes: Uint8Array) => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
const bytesOf = (data: string | Uint8Array) => (typeof data === 'string' ? utf8.encode(data) : data);

async function digest(hash: Hash, data: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest(hash, bytesOf(data) as BufferSource));
}

async function hmac(hash: Hash, key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', bytesOf(key) as BufferSource, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, bytesOf(data) as BufferSource));
}

/** MD5, which Web Crypto leaves out but Digest auth still defaults to. */
export function md5(input: string): string {
  const bytes = utf8.encode(input);
  const n = bytes.length;
  const words = new Uint32Array((((n + 8) >>> 6) + 1) * 16);
  for (let i = 0; i < n; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  words[words.length - 2] = (n * 8) >>> 0;
  words[words.length - 1] = Math.floor(n / 0x20000000);
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  let a = 0x67452301, b = 0xefcdab89 | 0, c = 0x98badcfe | 0, d = 0x10325476;
  for (let o = 0; o < words.length; o += 16) {
    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      let f: number, g: number;
      if (round === 0) { f = (B & C) | (~B & D); g = i; }
      else if (round === 1) { f = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (round === 2) { f = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { f = C ^ (B | ~D); g = (7 * i) % 16; }
      const k = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
      const x = (A + f + k + words[o + g]) | 0;
      const s = shifts[round * 4 + (i % 4)];
      A = D; D = C; C = B;
      B = (B + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  return [a, b, c, d].map((w) => [0, 8, 16, 24].map((sh) => ((w >>> sh) & 255).toString(16).padStart(2, '0')).join('')).join('');
}

/** Percent-encoding as RFC 3986 wants it (OAuth 1.0 and AWS both sign this form). */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

function randomToken(bytes = 16): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

const header = (r: ResolvedRequest, name: string) => r.headers.find(([k]) => k.toLowerCase() === name)?.[1];
const withHeader = (r: ResolvedRequest, name: string, value: string): ResolvedRequest => ({
  ...r,
  headers: [...r.headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase()), [name, value]],
});

export interface AuthContext {
  /** Time of the request in ms since 1970. Fixed in tests. */
  now?: number;
  /** Random value for nonces. Fixed in tests. */
  nonce?: string;
}

// ---------------------------------------------------------------- JWT

const JWT_HASH: Record<string, Hash> = { '256': 'SHA-256', '384': 'SHA-384', '512': 'SHA-512' };

function derLength(n: number): number[] {
  if (n < 128) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 255);
  return [0x80 | out.length, ...out];
}
const der = (tag: number, body: number[] | Uint8Array) => [tag, ...derLength(body.length), ...body];

/** Private key from PEM text as PKCS#8 bytes. "BEGIN RSA PRIVATE KEY" (PKCS#1) is wrapped on the way. */
function privateKeyBytes(pem: string): Uint8Array {
  const m = pem.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (!m) throw new Error('JWT: the private key must be PEM text that starts with -----BEGIN PRIVATE KEY-----');
  const body = fromBase64(m[2]);
  if (m[1] === 'PRIVATE KEY') return body;
  if (m[1] === 'RSA PRIVATE KEY') {
    const rsaOid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    return Uint8Array.from(der(0x30, [0x02, 0x01, 0x00, ...der(0x30, rsaOid), ...der(0x04, body)]));
  }
  if (m[1] === 'EC PRIVATE KEY') throw new Error('JWT: convert this EC key to PKCS#8 first: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem');
  throw new Error(`JWT: "${m[1]}" is not a private key that can sign`);
}

export async function signJwt(a: AuthOf<'jwt'>): Promise<string> {
  let payload: unknown;
  try {
    payload = JSON.parse(a.payload || '{}');
  } catch (e) {
    throw new Error(`JWT: the payload is not valid JSON (${(e as Error).message})`);
  }
  const hash = JWT_HASH[a.algorithm.slice(2)];
  const input = `${base64url(utf8.encode(JSON.stringify({ alg: a.algorithm, typ: 'JWT' })))}.${base64url(utf8.encode(JSON.stringify(payload)))}`;
  let signature: Uint8Array;
  if (a.algorithm.startsWith('HS')) {
    if (!a.secret) throw new Error('JWT: enter the secret to sign with');
    signature = await hmac(hash, a.secretBase64 ? fromBase64(a.secret) : a.secret, input);
  } else {
    const rsa = a.algorithm.startsWith('RS');
    const params = rsa ? { name: 'RSASSA-PKCS1-v1_5', hash } : { name: 'ECDSA', namedCurve: a.algorithm === 'ES256' ? 'P-256' : 'P-384' };
    let key: CryptoKey;
    try {
      key = await subtle().importKey('pkcs8', privateKeyBytes(a.secret) as BufferSource, params, false, ['sign']);
    } catch (e) {
      if ((e as Error).message.startsWith('JWT:')) throw e;
      throw new Error(`JWT: this private key does not fit ${a.algorithm} (${(e as Error).message || 'could not be read'})`);
    }
    signature = new Uint8Array(await subtle().sign(rsa ? 'RSASSA-PKCS1-v1_5' : { name: 'ECDSA', hash }, key, utf8.encode(input)));
  }
  return `${input}.${base64url(signature)}`;
}

// ---------------------------------------------------------------- OAuth 1.0 (RFC 5849)

async function oauth1Header(r: ResolvedRequest, a: AuthOf<'oauth1'>, ctx: AuthContext): Promise<string> {
  const url = new URL(r.url);
  const oauth: [string, string][] = [
    ['oauth_consumer_key', a.consumerKey],
    ['oauth_nonce', ctx.nonce ?? randomToken()],
    ['oauth_signature_method', a.signatureMethod],
    ['oauth_timestamp', String(Math.floor((ctx.now ?? Date.now()) / 1000))],
    ['oauth_version', '1.0'],
  ];
  if (a.token) oauth.push(['oauth_token', a.token]);

  const params: [string, string][] = [...oauth, ...url.searchParams];
  if (typeof r.body === 'string' && (header(r, 'content-type') ?? '').includes('x-www-form-urlencoded')) params.push(...new URLSearchParams(r.body));
  const normalized = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = `${r.method}&${rfc3986(`${url.protocol}//${url.host}${url.pathname}`)}&${rfc3986(normalized)}`;
  const key = `${rfc3986(a.consumerSecret)}&${rfc3986(a.tokenSecret)}`;
  const signature = a.signatureMethod === 'PLAINTEXT' ? key : base64(await hmac(a.signatureMethod === 'HMAC-SHA256' ? 'SHA-256' : 'SHA-1', key, base));

  const fields: [string, string][] = [...(a.realm ? ([['realm', a.realm]] as [string, string][]) : []), ...oauth, ['oauth_signature', signature]];
  return `OAuth ${fields.map(([k, v]) => `${k}="${k === 'realm' ? v : rfc3986(v)}"`).join(', ')}`;
}

// ---------------------------------------------------------------- Hawk

async function hawkHeader(r: ResolvedRequest, a: AuthOf<'hawk'>, ctx: AuthContext): Promise<string> {
  const url = new URL(r.url);
  const ts = String(Math.floor((ctx.now ?? Date.now()) / 1000));
  const nonce = ctx.nonce ?? randomToken(6);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const normalized = ['hawk.1.header', ts, nonce, r.method, `${url.pathname}${url.search}`, url.hostname.toLowerCase(), port, '', a.ext, ''].join('\n');
  const mac = base64(await hmac(a.algorithm === 'sha1' ? 'SHA-1' : 'SHA-256', a.key, normalized));
  return `Hawk id="${a.id}", ts="${ts}", nonce="${nonce}"${a.ext ? `, ext="${a.ext}"` : ''}, mac="${mac}"`;
}

// ---------------------------------------------------------------- AWS Signature Version 4

async function signAws(r: ResolvedRequest, a: AuthOf<'aws'>, ctx: AuthContext): Promise<ResolvedRequest> {
  const url = new URL(r.url);
  const amzDate = new Date(ctx.now ?? Date.now()).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const unsigned = !!r.multipart || !!r.file;
  const payloadHash = unsigned ? 'UNSIGNED-PAYLOAD' : hex(await digest('SHA-256', r.body ?? ''));

  let out = withHeader(r, 'X-Amz-Date', amzDate);
  if (a.sessionToken) out = withHeader(out, 'X-Amz-Security-Token', a.sessionToken);
  if (a.service === 's3' || unsigned) out = withHeader(out, 'X-Amz-Content-Sha256', payloadHash);

  const signed = new Map<string, string>([['host', url.host]]);
  for (const [k, v] of out.headers) {
    const name = k.toLowerCase();
    if (name === 'content-type' || name.startsWith('x-amz-')) signed.set(name, v.trim().replace(/\s+/g, ' '));
  }
  const names = [...signed.keys()].sort();

  // S3 signs the path as sent; every other service signs it encoded once more.
  const segment = (s: string) => {
    let plain = s;
    try {
      plain = decodeURIComponent(s);
    } catch {
      /* keep as is */
    }
    return a.service === 's3' ? rfc3986(plain) : rfc3986(rfc3986(plain));
  };
  const path = url.pathname.split('/').map(segment).join('/') || '/';
  const query = [...url.searchParams]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [r.method, path, query, ...names.map((n) => `${n}:${signed.get(n)}`), '', names.join(';'), payloadHash].join('\n');

  const scope = `${day}/${a.region}/${a.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(await digest('SHA-256', canonical))].join('\n');
  let key = await hmac('SHA-256', `AWS4${a.secretKey}`, day);
  for (const part of [a.region, a.service, 'aws4_request']) key = await hmac('SHA-256', key, part);
  const signature = hex(await hmac('SHA-256', key, toSign));
  return withHeader(out, 'Authorization', `AWS4-HMAC-SHA256 Credential=${a.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`);
}

// ---------------------------------------------------------------- Digest (RFC 7616 / 2617)

/** The Digest challenge from a 401's WWW-Authenticate header(s), or null when the server didn't offer Digest. */
export function parseDigestChallenge(headers: [string, string][]): Record<string, string> | null {
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== 'www-authenticate') continue;
    const at = v.search(/\bdigest\s/i);
    if (at < 0) continue;
    const out: Record<string, string> = {};
    for (const m of v.slice(at + 7).matchAll(/([a-z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi)) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
    if (out.nonce) return out;
  }
  return null;
}

export async function digestAuthorization(
  creds: { username: string; password: string },
  challenge: Record<string, string>,
  method: string,
  requestUrl: string,
  ctx: AuthContext = {},
): Promise<string> {
  const algorithm = challenge.algorithm ?? 'MD5';
  const base = algorithm.replace(/-sess$/i, '').toUpperCase();
  if (base !== 'MD5' && base !== 'SHA-256') throw new Error(`Digest auth: the server asks for ${algorithm}, which isn't supported`);
  const h = async (s: string) => (base === 'MD5' ? md5(s) : hex(await digest('SHA-256', s)));
  const url = new URL(requestUrl);
  const uri = `${url.pathname}${url.search}`;
  const realm = challenge.realm ?? '';
  const qop = (challenge.qop ?? '').split(',').map((q) => q.trim()).includes('auth') ? 'auth' : '';
  const cnonce = ctx.nonce ?? randomToken(8);
  const nc = '00000001';

  let ha1 = await h(`${creds.username}:${realm}:${creds.password}`);
  if (/-sess$/i.test(algorithm)) ha1 = await h(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = await h(`${method}:${uri}`);
  const response = qop ? await h(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : await h(`${ha1}:${challenge.nonce}:${ha2}`);

  const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  const parts = [`username=${q(creds.username)}`, `realm=${q(realm)}`, `nonce=${q(challenge.nonce)}`, `uri=${q(uri)}`, `algorithm=${algorithm}`, `response="${response}"`];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${q(cnonce)}`);
  if (challenge.opaque !== undefined) parts.push(`opaque=${q(challenge.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}

// ---------------------------------------------------------------- OAuth 2.0

export interface OAuth2Token {
  token: string;
  expiresAt?: number;
  /** token_type from the server, e.g. Bearer. */
  prefix?: string;
}

/** The request that asks the token URL for an access token. For the authorization code grant, pass what came back. */
export function oauth2TokenRequest(a: AuthOf<'oauth2'>, code?: { code: string; verifier: string }): ResolvedRequest {
  if (!a.tokenUrl.trim()) throw new Error('OAuth 2.0: enter the token URL');
  if (!a.clientId) throw new Error('OAuth 2.0: enter the client ID');
  const form = new URLSearchParams();
  form.set('grant_type', a.grant);
  if (a.grant === 'password') {
    form.set('username', a.username);
    form.set('password', a.password);
  }
  if (a.grant === 'authorization_code') {
    if (!code) throw new Error('OAuth 2.0: no authorization code yet');
    form.set('code', code.code);
    form.set('redirect_uri', a.redirectUri);
    form.set('code_verifier', code.verifier);
  } else if (a.scope.trim()) form.set('scope', a.scope.trim());

  const headers: [string, string][] = [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']];
  // A public client (no secret) can only identify itself in the body.
  if (a.clientAuth === 'basic' && a.clientSecret) headers.push(['Authorization', `Basic ${base64(utf8.encode(`${a.clientId}:${a.clientSecret}`))}`]);
  else {
    form.set('client_id', a.clientId);
    if (a.clientSecret) form.set('client_secret', a.clientSecret);
  }
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(a.tokenUrl.trim()) ? a.tokenUrl.trim() : `https://${a.tokenUrl.trim()}`;
  return { method: 'POST', url, headers, body: form.toString() };
}

/** Read the token URL's answer. Throws with the server's own explanation when it refused. */
export function readOAuth2Token(res: HttpResponse, now = Date.now()): OAuth2Token {
  if (res.error) throw new Error(`OAuth 2.0: could not reach the token URL (${res.error})`);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    // Some servers (GitHub's default) answer as a form.
    data = Object.fromEntries(new URLSearchParams(res.body));
  }
  if (typeof data.access_token === 'string' && data.access_token) {
    const seconds = Number(data.expires_in);
    const type = typeof data.token_type === 'string' ? data.token_type : '';
    return { token: data.access_token, expiresAt: seconds > 0 ? now + seconds * 1000 : undefined, prefix: /^bearer$/i.test(type) ? 'Bearer' : type || undefined };
  }
  const why = [data.error, data.error_description].filter((x) => typeof x === 'string' && x).join(': ');
  throw new Error(`OAuth 2.0: the token URL answered ${res.status}${why ? ` (${why})` : ''} without an access token`);
}

export interface OAuth2Authorize {
  /** Open this in a browser for the person to sign in. */
  url: string;
  state: string;
  verifier: string;
}

/** Start of the authorization code grant, with PKCE (S256). */
export async function oauth2Authorize(a: AuthOf<'oauth2'>): Promise<OAuth2Authorize> {
  if (!a.authUrl.trim()) throw new Error('OAuth 2.0: enter the authorization URL');
  if (!a.clientId) throw new Error('OAuth 2.0: enter the client ID');
  const verifier = randomToken(32);
  const state = randomToken(12);
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(a.authUrl.trim()) ? a.authUrl.trim() : `https://${a.authUrl.trim()}`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', a.clientId);
  url.searchParams.set('redirect_uri', a.redirectUri);
  if (a.scope.trim()) url.searchParams.set('scope', a.scope.trim());
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', base64url(await digest('SHA-256', verifier)));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, verifier };
}

/** The code from the address the sign-in page sent the browser back to. */
export function readOAuth2Redirect(redirected: string, state: string): string {
  const url = new URL(redirected);
  const params = url.searchParams.has('code') || url.searchParams.has('error') ? url.searchParams : new URLSearchParams(url.hash.slice(1));
  const error = params.get('error');
  if (error) throw new Error(`OAuth 2.0: sign-in was refused (${[error, params.get('error_description')].filter(Boolean).join(': ')})`);
  const code = params.get('code');
  if (!code) throw new Error('OAuth 2.0: the sign-in page came back without a code');
  if (params.get('state') !== state) throw new Error('OAuth 2.0: the answer does not belong to this sign-in (state mismatch); nothing was saved');
  return code;
}

// ---------------------------------------------------------------- putting it on a request

/** Add computed auth to a request whose variables are already filled in. A header the request sets itself always wins. */
export async function applyAuth(r: ResolvedRequest, auth: Auth, ctx: AuthContext = {}): Promise<ResolvedRequest> {
  if (header(r, 'authorization') !== undefined) return r;
  switch (auth.type) {
    case 'jwt': return withHeader(r, 'Authorization', `${auth.prefix.trim()} ${await signJwt(auth)}`.trim());
    case 'oauth1': return auth.consumerKey ? withHeader(r, 'Authorization', await oauth1Header(r, auth, ctx)) : r;
    case 'hawk': return auth.id && auth.key ? withHeader(r, 'Authorization', await hawkHeader(r, auth, ctx)) : r;
    case 'aws': return auth.accessKey && auth.secretKey ? signAws(r, auth, ctx) : r;
    default: return r;
  }
}

export interface PreparedRequest {
  request: ResolvedRequest;
  missing: string[];
  /** Set for Digest auth: the request is answered with a challenge first. */
  digest?: { username: string; password: string };
}

/** Everything that happens before a send: variables, params, body and auth (signatures included). */
export async function prepareRequest(item: RequestItem, vars: VarMap, ctx: AuthContext = {}): Promise<PreparedRequest> {
  const { request, missing, auth } = resolveRequest(item, vars);
  if (!request.url) return { request, missing };
  return {
    request: await applyAuth(request, auth, ctx),
    missing,
    digest: auth.type === 'digest' && auth.username && header(request, 'authorization') === undefined ? { username: auth.username, password: auth.password } : undefined,
  };
}

export interface SentExchange {
  response: HttpResponse;
  /** The request that produced `response` (for Digest, the second one, with its Authorization header). */
  sent: ResolvedRequest;
}

/** Send a prepared request. With Digest auth, a 401 challenge is answered and the request sent again. */
export async function sendPrepared(send: (r: ResolvedRequest) => Promise<HttpResponse>, p: PreparedRequest, ctx: AuthContext = {}): Promise<SentExchange> {
  const first = await send(p.request);
  if (!p.digest || first.status !== 401) return { response: first, sent: p.request };
  const challenge = parseDigestChallenge(first.headers);
  if (!challenge) return { response: first, sent: p.request };
  const sent = withHeader(p.request, 'Authorization', await digestAuthorization(p.digest, challenge, p.request.method, p.request.url, ctx));
  return { response: await send(sent), sent };
}
