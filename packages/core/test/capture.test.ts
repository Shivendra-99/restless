import { describe, expect, it } from 'vitest';
import { buildHar, capturedToRequest, capturedToResolved, harToEntry, parseHar, responseText, toCurl, type CapturedEntry, type HarEntry } from '../src';

const entry = (p: Partial<CapturedEntry> = {}): CapturedEntry => ({
  id: 'e1',
  sessionId: 's1',
  startedAt: Date.UTC(2026, 10, 9, 7, 0, 0),
  method: 'POST',
  url: 'https://api.shop.test/v1/orders?draft=1',
  type: 'fetch',
  requestHeaders: [
    [':authority', 'api.shop.test'],
    ['content-type', 'application/json'],
    ['authorization', 'Bearer abc'],
    ['cookie', 'sid=1'],
    ['content-length', '12'],
    ['sec-ch-ua', '"Chromium"'],
    ['accept-encoding', 'gzip'],
  ],
  requestBody: '{"sku":42}',
  status: 201,
  statusText: 'Created',
  responseHeaders: [['content-type', 'application/json']],
  responseBody: '{"id":7}',
  durationMs: 120,
  ...p,
});

describe('captured → request', () => {
  it('keeps method, URL, auth and cookies; drops pseudo and engine headers; switches off fingerprint headers', () => {
    const r = capturedToRequest(entry(), 'c1', 'Captured');
    expect(r).toMatchObject({ method: 'POST', url: 'https://api.shop.test/v1/orders?draft=1', collectionId: 'c1', folder: 'Captured', name: 'POST /v1/orders' });
    expect(r.headers.map((h) => [h.key, h.enabled])).toEqual([
      ['authorization', true],
      ['cookie', true],
      ['sec-ch-ua', false],
    ]);
    expect(r.body).toEqual({ mode: 'json', text: '{\n  "sku": 42\n}', form: [] });
  });
  it('turns urlencoded bodies into form rows and keeps unknown bodies as text', () => {
    const form = capturedToRequest(entry({ requestHeaders: [['Content-Type', 'application/x-www-form-urlencoded']], requestBody: 'a=1&b=hello+world' }), 'c');
    expect(form.body.form).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: 'hello world', enabled: true },
    ]);
    const text = capturedToRequest(entry({ requestHeaders: [['content-type', 'text/plain']], requestBody: 'hi' }), 'c');
    expect(text.body).toEqual({ mode: 'text', text: 'hi', form: [] });
    expect(text.headers.map((h) => h.key)).toEqual(['content-type']);
  });
  it('makes a cURL command', () => {
    const curl = toCurl(capturedToResolved(entry()));
    expect(curl).toContain("-X POST");
    expect(curl).toContain("'authorization: Bearer abc'");
    expect(curl).not.toContain('sec-ch-ua');
    expect(curl).not.toContain(':authority');
  });
  it('decodes base64 text bodies but not images', () => {
    expect(responseText(entry({ responseBody: btoa('{"ok":true}'), responseBodyBase64: true, mimeType: 'application/json' }))).toBe('{"ok":true}');
    expect(responseText(entry({ responseBody: 'iVBOR', responseBodyBase64: true, mimeType: 'image/png' }))).toBeNull();
  });
});

describe('HAR', () => {
  const har: HarEntry = {
    startedDateTime: '2026-11-09T07:00:01.000Z',
    time: 88.6,
    request: { method: 'GET', url: 'https://x.test/me', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
    response: { status: 200, statusText: 'OK', headers: [{ name: 'Content-Type', value: 'application/json' }], content: { mimeType: 'application/json', text: '{"id":1}', size: 8 } },
    _resourceType: 'fetch',
  };
  it('converts entries, and DevTools getContent() overrides the body', () => {
    const e = harToEntry(har, 's');
    expect(e).toMatchObject({ method: 'GET', status: 200, type: 'fetch', durationMs: 89, responseBody: '{"id":1}', startedAt: Date.parse(har.startedDateTime) });
    expect(harToEntry(har, 's', { text: 'aGk=', encoding: 'base64' })).toMatchObject({ responseBody: 'aGk=', responseBodyBase64: true });
    expect(harToEntry(har, 's', { text: null }).responseBody).toBeUndefined();
  });
  it('round-trips through buildHar and parseHar, sorted by time', () => {
    const later = entry({ id: 'b', startedAt: Date.parse('2026-11-09T07:00:05.000Z') });
    const earlier = harToEntry(har, 's1');
    const text = JSON.stringify(buildHar({ id: 's1', name: 'x', source: 'recorder', startedAt: 0, entryCount: 2 }, [later, earlier]));
    const { session, entries } = parseHar(text, 'Back');
    expect(session).toMatchObject({ name: 'Back', source: 'har', entryCount: 2, startedAt: earlier.startedAt });
    expect(entries.map((e) => [e.method, e.status, e.url])).toEqual([
      ['GET', 200, 'https://x.test/me'],
      ['POST', 201, 'https://api.shop.test/v1/orders?draft=1'],
    ]);
    expect(entries[1].requestBody).toBe('{"sku":42}');
    expect(entries.every((e) => e.sessionId === session.id)).toBe(true);
  });
  it('explains files that are not HAR', () => {
    expect(() => parseHar('nope')).toThrow(/not valid JSON/);
    expect(() => parseHar('{"a":1}')).toThrow(/log.entries/);
  });
  it('caps very large bodies with a note', () => {
    const big = harToEntry({ ...har, response: { ...har.response, content: { text: 'x'.repeat(1_200_000) } } }, 's');
    expect(big.responseBody?.length).toBe(1_000_000);
    expect(big.note).toMatch(/first 1 MB/);
  });
});
