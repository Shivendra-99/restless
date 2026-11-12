import { describe, expect, it } from 'vitest';
import {
  applyAuth,
  digestAuthorization,
  exportPostmanCollection,
  formatPairs,
  importPostmanCollection,
  looksLikeManyPairs,
  md5,
  newAuth,
  newRequest,
  oauth2Authorize,
  oauth2TokenRequest,
  parseCurl,
  parseDigestChallenge,
  parsePairs,
  prepareRequest,
  readOAuth2Redirect,
  readOAuth2Token,
  resolveRequest,
  sendPrepared,
  signJwt,
  toCurl,
  usedVariables,
  type Auth,
  type HttpResponse,
  type ResolvedRequest,
} from '../src';

// Web Crypto only, so these tests run wherever the code does.
const enc = new TextEncoder();
const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer)));
const b64url = (bytes: ArrayBuffer | Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const pem = (der: ArrayBuffer) => `-----BEGIN PRIVATE KEY-----\n${b64(der).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;

const pairs = (text: string) => parsePairs(text).rows.map((r) => `${r.enabled ? '' : '#'}${r.key}=${r.value}`);

describe('bulk edit', () => {
  it('reads key: value, key=value and tab-separated lines, keeping switched-off ones', () => {
    const text = 'page: 1\nurl=https://a.test/x?y=1\nAuthorization: Bearer a=b\nname\tAsha\n# debug: true\n// old = 1\n\n"q": "tea",';
    expect(pairs(text)).toEqual(['page=1', 'url=https://a.test/x?y=1', 'Authorization=Bearer a=b', 'name=Asha', '#debug=true', '#old=1', 'q=tea']);
    expect(parsePairs(text).format).toBe('lines');
  });

  it('reads JSON: nested objects, lists and Postman-style lists', () => {
    expect(pairs('{"page":2,"ok":true,"none":null,"filter":{"role":"admin","tags":["a","b"]},"items":[{"id":1}]}')).toEqual(['page=2', 'ok=true', 'none=', 'filter.role=admin', 'filter.tags=a', 'filter.tags=b', 'items[0].id=1']);
    expect(pairs('[{"key":"a","value":"1"},{"name":"b","value":2,"disabled":true}]')).toEqual(['a=1', '#b=2']);
    expect(parsePairs('{"a":1}').format).toBe('json');
  });

  it('reads XML in the usual shapes', () => {
    expect(pairs('<?xml version="1.0"?><params><page>2</page><q>tea &amp; chai</q><filter><role>admin</role></filter><note><![CDATA[a<b]]></note></params>')).toEqual(['page=2', 'q=tea & chai', 'filter.role=admin', 'note=a<b']);
    expect(pairs('<params><param name="page" value="2"/><entry key="q">tea</entry><param name="off" value="1" enabled="false"/></params>')).toEqual(['page=2', 'q=tea', '#off=1']);
    expect(parsePairs('<a><b>1</b></a>').format).toBe('xml');
    // Broken XML is not guessed at.
    expect(parsePairs('<a><b>1</a>').format).toBe('lines');
  });

  it('reads a query string or a whole URL', () => {
    expect(pairs('https://api.test/users?page=2&q=tea%20leaf&flag#top')).toEqual(['page=2', 'q=tea leaf', 'flag=']);
    expect(pairs('a=1&b=x+y')).toEqual(['a=1', 'b=x y']);
    expect(parsePairs('?a=1').format).toBe('query');
  });

  it('round-trips through the text form', () => {
    const rows = [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: 'x: y', enabled: false }];
    expect(parsePairs(formatPairs(rows)).rows).toEqual(rows);
  });

  it('only treats a paste as many rows when it clearly is', () => {
    expect(looksLikeManyPairs('hello')).toBe(false);
    expect(looksLikeManyPairs('Bearer abc: def')).toBe(false);
    expect(looksLikeManyPairs('a: 1\nb: 2')).toBe(true);
    expect(looksLikeManyPairs('{"a":1}')).toBe(true);
    expect(looksLikeManyPairs('a=1&b=2')).toBe(true);
  });
});

describe('file bodies', () => {
  const photo = { id: 'f1', name: 'photo.png', path: '/tmp/photo.png' };

  it('multipart: text and file parts, no Content-Type of its own', () => {
    const item = newRequest({
      method: 'POST',
      url: 'https://x.test/upload',
      headers: [{ key: 'Content-Type', value: 'multipart/form-data', enabled: true }],
      body: { mode: 'multipart', text: '', form: [], multipart: [{ key: 'title', value: '{{t}}', enabled: true }, { key: 'photo', value: '', enabled: true, file: photo }, { key: 'later', value: '', enabled: true, file: null }, { key: 'off', value: 'x', enabled: false }] },
    });
    const { request } = resolveRequest(item, { t: 'Hi' });
    expect(request.multipart).toEqual([{ name: 'title', value: 'Hi' }, { name: 'photo', file: photo }]);
    expect(request.headers).toEqual([]);
    expect(request.body).toBeUndefined();
    expect(toCurl(request)).toContain("-F 'title=Hi'");
    expect(toCurl(request)).toContain("-F 'photo=@/tmp/photo.png'");
    expect(usedVariables(item)).toEqual(['t']);
  });

  it('file: sent whole, with a content type from its name', () => {
    const { request } = resolveRequest(newRequest({ method: 'PUT', url: 'https://x.test/a', body: { mode: 'file', text: '', form: [], file: photo } }), {});
    expect(request.file).toEqual(photo);
    expect(request.headers).toEqual([['Content-Type', 'image/png']]);
    expect(toCurl(request)).toContain("--data-binary '@/tmp/photo.png'");
  });

  it('GET sends no file', () => {
    const { request } = resolveRequest(newRequest({ url: 'https://x.test/a', body: { mode: 'file', text: '', form: [], file: photo } }), {});
    expect(request.file).toBeUndefined();
  });

  it('cURL -F and --data-binary @file import', () => {
    const a = parseCurl(`curl https://x.test/up -F 'title=Hi' -F 'photo=@/tmp/a b.png;type=image/png'`).request;
    expect(a.method).toBe('POST');
    expect(a.body.mode).toBe('multipart');
    expect(a.body.multipart?.map((f) => [f.key, f.value, f.file?.path, f.file?.contentType])).toEqual([['title', 'Hi', undefined, undefined], ['photo', '', '/tmp/a b.png', 'image/png']]);
    const b = parseCurl(`curl -X PUT https://x.test/up --data-binary @report.pdf`).request;
    expect([b.body.mode, b.body.file?.name, b.body.file?.contentType]).toEqual(['file', 'report.pdf', 'application/pdf']);
  });

  it('Postman form-data survives export and import', () => {
    const c = { id: 'c', name: 'C', folders: [] };
    const item = newRequest({ collectionId: 'c', method: 'POST', url: 'https://x.test', body: { mode: 'multipart', text: '', form: [], multipart: [{ key: 'a', value: '1', enabled: true }, { key: 'f', value: '', enabled: true, file: photo }] } });
    const back = importPostmanCollection(exportPostmanCollection(c, [item])).requests[0];
    expect(back.body.multipart?.map((f) => [f.key, f.value, f.file?.path])).toEqual([['a', '1', undefined], ['f', '', '/tmp/photo.png']]);
  });
});

const get = (r: ResolvedRequest, name: string) => r.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('signed auth', () => {
  it('MD5: the test suite of RFC 1321', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('Digest: the worked example of RFC 2617', async () => {
    const challenge = parseDigestChallenge([['WWW-Authenticate', 'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"']])!;
    const h = await digestAuthorization({ username: 'Mufasa', password: 'Circle Of Life' }, challenge, 'GET', 'http://www.nowhere.org/dir/index.html', { nonce: '0a4f113b' });
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain('uri="/dir/index.html"');
    expect(h).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('Digest: SHA-256 example of RFC 7616, and the 401 is answered', async () => {
    const www: [string, string] = ['WWW-Authenticate', 'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"'];
    const item = newRequest({ url: 'http://www.example.org/dir/index.html', auth: { type: 'digest', username: 'Mufasa', password: 'Circle of Life' } });
    const seen: ResolvedRequest[] = [];
    const send = async (r: ResolvedRequest): Promise<HttpResponse> => {
      seen.push(r);
      return { status: get(r, 'authorization') ? 200 : 401, statusText: '', headers: get(r, 'authorization') ? [] : [www], body: '', size: 0, timings: { total: 1 }, url: r.url };
    };
    const { response, sent } = await sendPrepared(send, await prepareRequest(item, {}), { nonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ' });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(get(sent, 'authorization')).toContain('response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"');
  });

  it('AWS Signature V4: the example from the AWS docs', async () => {
    const r: ResolvedRequest = { method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', headers: [['Content-Type', 'application/x-www-form-urlencoded; charset=utf-8']] };
    const auth: Auth = { type: 'aws', accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'iam', sessionToken: '' };
    const out = await applyAuth(r, auth, { now: Date.UTC(2015, 7, 30, 12, 36, 0) });
    expect(get(out, 'x-amz-date')).toBe('20150830T123600Z');
    expect(get(out, 'authorization')).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('OAuth 1.0: the example of RFC 5849 section 3.4.1', async () => {
    const r: ResolvedRequest = {
      method: 'POST',
      url: 'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',
      headers: [['Content-Type', 'application/x-www-form-urlencoded']],
      body: 'c2&a3=2+q',
    };
    const auth: Auth = { type: 'oauth1', consumerKey: '9djdj82h48djs9d2', consumerSecret: 'j49sk3j29djd', token: 'kkk9d7dh3k39sjv7', tokenSecret: 'dh893hdasih9', signatureMethod: 'HMAC-SHA1', realm: 'Example' };
    const h = get(await applyAuth(r, auth, { now: 137131201000, nonce: '7d8f3e4a' }), 'authorization')!;
    // The RFC's example leaves oauth_version out; with it the signature differs, so check against the RFC's own base-string rules instead.
    const base =
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7%26oauth_version%3D1.0';
    const key = await crypto.subtle.importKey('raw', enc.encode('j49sk3j29djd&dh893hdasih9'), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const expected = b64(await crypto.subtle.sign('HMAC', key, enc.encode(base)));
    expect(h).toContain(`oauth_signature="${encodeURIComponent(expected)}"`);
    expect(h.startsWith('OAuth realm="Example", oauth_consumer_key="9djdj82h48djs9d2"')).toBe(true);
  });

  it('Hawk: the example from the Hawk readme', async () => {
    const r: ResolvedRequest = { method: 'GET', url: 'http://example.com:8000/resource/1?b=1&a=2', headers: [] };
    const auth: Auth = { type: 'hawk', id: 'dh37fgj492je', key: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn', algorithm: 'sha256', ext: 'some-app-ext-data' };
    const h = get(await applyAuth(r, auth, { now: 1353832234000, nonce: 'j4h3g2' }), 'authorization');
    expect(h).toBe('Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="');
  });

  it('JWT: HS256 is the jwt.io example; RS256 and ES256 verify', async () => {
    const hs = await signJwt({ type: 'jwt', algorithm: 'HS256', secret: 'your-256-bit-secret', secretBase64: false, payload: '{"sub":"1234567890","name":"John Doe","iat":1516239022}', prefix: 'Bearer' });
    expect(hs).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');

    const rsa = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const rs = (await signJwt({ type: 'jwt', algorithm: 'RS256', secret: pem(await crypto.subtle.exportKey('pkcs8', rsa.privateKey)), secretBase64: false, payload: '{"a":1}', prefix: 'Bearer' })).split('.');
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', rsa.publicKey, unb64url(rs[2]), enc.encode(`${rs[0]}.${rs[1]}`))).toBe(true);

    const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const es = (await signJwt({ type: 'jwt', algorithm: 'ES256', secret: pem(await crypto.subtle.exportKey('pkcs8', ec.privateKey)), secretBase64: false, payload: '{"a":1}', prefix: '' })).split('.');
    expect(JSON.parse(atob(es[0]))).toEqual({ alg: 'ES256', typ: 'JWT' });
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, ec.publicKey, unb64url(es[2]), enc.encode(`${es[0]}.${es[1]}`))).toBe(true);
  });

  it('JWT problems are explained', async () => {
    const jwt = newAuth('jwt') as Extract<Auth, { type: 'jwt' }>;
    await expect(signJwt({ ...jwt, secret: 's', payload: '{oops' })).rejects.toThrow(/payload is not valid JSON/);
    await expect(signJwt({ ...jwt, algorithm: 'RS256', secret: 'not a key', payload: '{}' })).rejects.toThrow(/must be PEM text/);
  });

  it('prepareRequest fills variables into auth and signs; a header of your own wins', async () => {
    const item = newRequest({ url: 'https://x.test/a', auth: { ...(newAuth('jwt') as Extract<Auth, { type: 'jwt' }>), secret: '{{secret}}', payload: '{"sub":"{{who}}","iat":{{$timestamp}}}' } });
    expect(usedVariables(item)).toEqual(['secret', 'who']);
    const { request, missing } = await prepareRequest(item, { secret: 'k', who: 'asha' });
    expect(missing).toEqual([]);
    const [, payload] = get(request, 'authorization')!.replace('Bearer ', '').split('.');
    expect(JSON.parse(new TextDecoder().decode(unb64url(payload))).sub).toBe('asha');
    const own = await prepareRequest({ ...item, headers: [{ key: 'Authorization', value: 'mine', enabled: true }] }, {});
    expect(get(own.request, 'authorization')).toBe('mine');
  });
});

describe('OAuth 2.0', () => {
  const base = { ...(newAuth('oauth2') as Extract<Auth, { type: 'oauth2' }>), tokenUrl: 'https://id.test/token', clientId: 'app', clientSecret: 's3cret', scope: 'read write' };

  it('client credentials: Basic header or body', () => {
    const a = oauth2TokenRequest(base);
    expect(a.body).toBe('grant_type=client_credentials&scope=read+write');
    expect(get(a, 'authorization')).toBe(`Basic ${btoa('app:s3cret')}`);
    const b = oauth2TokenRequest({ ...base, clientAuth: 'body' });
    expect(b.body).toBe('grant_type=client_credentials&scope=read+write&client_id=app&client_secret=s3cret');
    expect(get(b, 'authorization')).toBeUndefined();
  });

  it('password grant', () => {
    expect(oauth2TokenRequest({ ...base, grant: 'password', username: 'asha', password: 'p w' }).body).toBe('grant_type=password&username=asha&password=p+w&scope=read+write');
  });

  it('authorization code with PKCE', async () => {
    const a = { ...base, grant: 'authorization_code' as const, authUrl: 'https://id.test/authorize?tenant=1', clientSecret: '' };
    const start = await oauth2Authorize(a);
    const url = new URL(start.url);
    expect(url.searchParams.get('tenant')).toBe('1');
    expect(url.searchParams.get('code_challenge')).toBe(b64url(await crypto.subtle.digest('SHA-256', enc.encode(start.verifier))));
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/callback');
    expect(readOAuth2Redirect(`http://localhost/callback?code=abc&state=${start.state}`, start.state)).toBe('abc');
    expect(() => readOAuth2Redirect('http://localhost/callback?code=abc&state=other', start.state)).toThrow(/state mismatch/);
    expect(() => readOAuth2Redirect('http://localhost/callback?error=access_denied&error_description=No', start.state)).toThrow(/access_denied: No/);
    // No secret: the client can only name itself in the body.
    expect(oauth2TokenRequest(a, { code: 'abc', verifier: 'v' }).body).toBe('grant_type=authorization_code&code=abc&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&code_verifier=v&client_id=app');
  });

  it('reads the token answer, JSON or form, and explains a refusal', () => {
    const res = (status: number, body: string): HttpResponse => ({ status, statusText: '', headers: [], body, size: 0, timings: { total: 1 }, url: '' });
    expect(readOAuth2Token(res(200, '{"access_token":"t","token_type":"bearer","expires_in":60}'), 1000)).toEqual({ token: 't', expiresAt: 61000, prefix: 'Bearer' });
    expect(readOAuth2Token(res(200, 'access_token=t2&token_type=bearer')).token).toBe('t2');
    expect(() => readOAuth2Token(res(401, '{"error":"invalid_client","error_description":"Bad secret"}'))).toThrow(/401 \(invalid_client: Bad secret\)/);
  });

  it('the token is sent with its prefix', () => {
    expect(base.token).toBe('{{oauth_token}}');
    const { request } = resolveRequest(newRequest({ url: 'https://x.test', auth: { ...base, token: '{{tok}}', prefix: 'Bearer' } }), { tok: 'abc' });
    expect(get(request, 'authorization')).toBe('Bearer abc');
  });

  it('Postman auth kinds survive export and import', () => {
    const c = { id: 'c', name: 'C', folders: [] };
    const kinds: Auth[] = [{ ...base, token: 't' }, { type: 'digest', username: 'u', password: 'p' }, { type: 'aws', accessKey: 'a', secretKey: 's', region: 'eu-west-1', service: 's3', sessionToken: '' }, { type: 'hawk', id: 'i', key: 'k', algorithm: 'sha1', ext: 'e' }, { ...(newAuth('oauth1') as Extract<Auth, { type: 'oauth1' }>), consumerKey: 'ck', signatureMethod: 'HMAC-SHA256' }, { ...(newAuth('jwt') as Extract<Auth, { type: 'jwt' }>), secret: 's', payload: '{"a":1}' }];
    const items = kinds.map((auth) => newRequest({ collectionId: 'c', url: 'https://x.test', auth }));
    const back = importPostmanCollection(exportPostmanCollection(c, items));
    expect(back.warnings).toEqual([]);
    expect(back.requests.map((r) => r.auth)).toEqual(kinds);
  });
});
