// Extension HTTP engine. Extension pages with host permission are not bound by CORS.
// Headers the browser forbids in fetch() (Cookie, Origin, Referer, Host, User-Agent…) are applied
// with a short-lived declarativeNetRequest session rule scoped to this extension and the target host.
import type { HttpResponse, ResolvedRequest } from '@restless/core';

const FORBIDDEN = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'via', 'user-agent',
]);
const isForbidden = (name: string) => {
  const n = name.toLowerCase();
  return FORBIDDEN.has(n) || n.startsWith('proxy-') || n.startsWith('sec-');
};
// DNR can't set these (the network stack owns them), so they are reported as dropped.
const DNR_UNSETTABLE = new Set(['content-length', 'connection', 'transfer-encoding', 'keep-alive', 'te', 'trailer', 'upgrade', 'host', 'expect']);

let nextRuleId = 1000 + Math.floor(Math.random() * 1000);

/** Ask for host access to one origin. Must run inside a user gesture (Send / Connect click). */
export async function ensureHostAccess(url: string): Promise<void> {
  const u = new URL(url);
  const origin = `${u.protocol}//${u.hostname}/*`;
  // Call request() first, with no await before it: an await would end the user gesture.
  // It resolves to true without prompting when access was already granted.
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`Restless needs permission to reach ${u.hostname}. Allow it when Chrome asks, then send again.`);
}

let current: AbortController | null = null;

export function cancel() {
  current?.abort();
}

export async function sendViaFetch(r: ResolvedRequest): Promise<HttpResponse> {
  // Permission prompt first, while we are still inside the click's user gesture.
  await ensureHostAccess(r.url);

  const allowed = new Headers();
  const special: [string, string][] = [];
  const dropped: string[] = [];
  for (const [k, v] of r.headers) {
    if (!k) continue;
    if (!isForbidden(k)) {
      try {
        allowed.append(k, v);
      } catch {
        dropped.push(k);
      }
    } else if (DNR_UNSETTABLE.has(k.toLowerCase())) dropped.push(k);
    else special.push([k, v]);
  }

  const url = new URL(r.url);
  let ruleId: number | null = null;
  if (special.length) {
    ruleId = nextRuleId++;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              requestHeaders: special.map(([header, value]) => ({ header, operation: chrome.declarativeNetRequest.HeaderOperation.SET, value })),
            },
            condition: {
              requestDomains: [url.hostname],
              initiatorDomains: [chrome.runtime.id],
              resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
            },
          },
        ],
      });
    } catch (e) {
      ruleId = null;
      dropped.push(...special.map(([k]) => k));
      console.warn('Could not install header rule', e);
    }
  }

  current = new AbortController();
  const timeout = setTimeout(() => current?.abort(new DOMException('timeout', 'TimeoutError')), r.timeoutMs ?? 60_000);
  const t0 = performance.now();
  try {
    const res = await fetch(r.url, {
      method: r.method,
      headers: allowed,
      body: r.body,
      redirect: r.followRedirects === false ? 'manual' : 'follow',
      // Isolated from the browser's own cookies by default, like a real API client.
      credentials: 'omit',
      cache: 'no-store',
      signal: current.signal,
    });
    const tHeaders = performance.now();
    const buf = await res.arrayBuffer();
    const tEnd = performance.now();
    const ct = res.headers.get('content-type') ?? '';
    const isText = !ct || /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|[\w.+-]*\+(json|xml)))|charset=/i.test(ct);
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    return {
      status: res.status,
      statusText: res.statusText,
      headers,
      body: isText ? new TextDecoder().decode(buf) : `[binary ${ct || 'data'}, ${buf.byteLength} bytes]`,
      size: buf.byteLength,
      timings: { ttfb: tHeaders - t0, download: tEnd - tHeaders, total: tEnd - t0 },
      url: res.url || r.url,
      droppedHeaders: dropped.length ? dropped : undefined,
    };
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new Error('Request cancelled');
    if (err.name === 'TimeoutError') throw new Error(`No response within ${Math.round((r.timeoutMs ?? 60_000) / 1000)} s`);
    throw new Error(`Network error reaching ${url.host}: the server may be down, the address wrong, or the certificate untrusted. (${err.message})`);
  } finally {
    clearTimeout(timeout);
    current = null;
    if (ruleId !== null) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
  }
}
