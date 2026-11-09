// Service worker: opens the app, and runs network capture.
//   Recorder  – chrome.debugger on one tab: full requests and responses, live.
//   Rewind    – webRequest keeps the last 5 minutes of API calls from all tabs (no response bodies),
//               so requests made before pressing Record can still be grabbed.
//   DevTools  – the Restless panel in F12 streams entries here over a port.
//   Desktop   – everything captured is forwarded to a paired Restless desktop app on 127.0.0.1.
import { capBody, headerList, isApiType, newId, newSession, type CapturedEntry, type CaptureSession } from '@restless/core';
import * as store from './capture-db';

const DESKTOP_PORTS = [47321, 47322, 47323, 47324, 47325];
const REWIND_MS = 5 * 60 * 1000;
const REWIND_MAX = 400;
const MAX_ENTRIES = 5000;
const OWN_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

// ---------------------------------------------------------------- app window

async function openApp(hash = '') {
  const base = chrome.runtime.getURL('app.html');
  const [existing] = await chrome.tabs.query({ url: `${base}*` });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true, url: `${base}${hash}` });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url: `${base}${hash}` });
}

chrome.runtime.onStartup.addListener(async () => {
  // Clear header-rewrite rules left over if the app tab was closed mid-request.
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
});

// ---------------------------------------------------------------- desktop link

interface Link {
  port: number;
  token: string;
}
let reachable = true;
const outbox = new Map<string, { session: CaptureSession; entries: Map<string, CapturedEntry> }>();
let outboxTimer: ReturnType<typeof setTimeout> | undefined;

const getLink = async () => ((await chrome.storage.local.get('desktopLink')).desktopLink as Link | undefined) ?? null;

function browserName() {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands?.map((b) => b.brand) ?? [];
  return brands.find((b) => /Edge/.test(b)) ? 'Microsoft Edge' : brands.find((b) => /Google Chrome/.test(b)) ? 'Google Chrome' : brands.find((b) => /Brave/.test(b)) ? 'Brave' : brands.find((b) => /Chromium/.test(b)) ? 'Chromium' : 'Browser';
}

async function postDesktop(link: Link, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${link.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${link.token}` },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    // The desktop app forgot this browser (disconnected there).
    await chrome.storage.local.remove('desktopLink');
    throw new Error('The desktop app disconnected this browser. Connect again with a new code.');
  }
  if (!res.ok) throw new Error(`Desktop app answered ${res.status}`);
}

function queueForDesktop(session: CaptureSession, entries: CapturedEntry[]) {
  const item = outbox.get(session.id) ?? { session, entries: new Map() };
  item.session = session;
  for (const e of entries) item.entries.set(e.id, e);
  outbox.set(session.id, item);
  clearTimeout(outboxTimer);
  outboxTimer = setTimeout(() => void flushDesktop(), 400);
}

async function flushDesktop() {
  const link = await getLink();
  const items = [...outbox.values()];
  outbox.clear();
  if (!link) return;
  for (const { session, entries } of items) {
    try {
      await postDesktop(link, '/v1/capture', { session, entries: [...entries.values()] });
      reachable = true;
    } catch {
      reachable = false;
    }
  }
}

async function connectDesktop(code: string) {
  for (const port of DESKTOP_PORTS) {
    let hello: { app?: string } | null = null;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 800);
      hello = await (await fetch(`http://127.0.0.1:${port}/v1/hello`, { signal: ac.signal })).json();
      clearTimeout(t);
    } catch {
      continue;
    }
    if (hello?.app !== 'restless') continue;
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: browserName() }) });
    if (res.status === 403 || res.status === 429) throw new Error((await res.json().catch(() => null))?.error ?? 'That code is not right or has expired. Make a new one in the desktop app.');
    if (!res.ok) throw new Error(`The desktop app answered ${res.status}`);
    const { token } = (await res.json()) as { token: string };
    await chrome.storage.local.set({ desktopLink: { port, token } satisfies Link });
    reachable = true;
    return;
  }
  throw new Error('Could not find the Restless desktop app on this computer. Open it, go to Capture, and try again.');
}

async function resendToDesktop(sessionId: string) {
  const link = await getLink();
  if (!link) throw new Error('Not connected to the desktop app');
  const session = await store.getSession(sessionId);
  if (!session) throw new Error('That capture no longer exists');
  const entries = await store.getEntries(sessionId);
  for (let i = 0; i < Math.max(1, entries.length); i += 200) await postDesktop(link, '/v1/capture', { session, entries: entries.slice(i, i + 200) });
  reachable = true;
}

// ---------------------------------------------------------------- saving

async function saveEntries(session: CaptureSession, entries: CapturedEntry[]) {
  if (!entries.length) return;
  await store.putEntries(session, entries);
  store.notify(session.id);
  queueForDesktop(session, entries);
}

/** Recorder entries arrive one by one; write them in small batches. */
const batches = new Map<string, { session: CaptureSession; entries: CapturedEntry[] }>();
let batchTimer: ReturnType<typeof setTimeout> | undefined;
function saveSoon(session: CaptureSession, entry: CapturedEntry) {
  const b = batches.get(session.id) ?? { session, entries: [] };
  b.entries.push(entry);
  batches.set(session.id, b);
  batchTimer ??= setTimeout(() => void flushBatches(), 120);
}
async function flushBatches() {
  batchTimer = undefined;
  const list = [...batches.values()];
  batches.clear();
  for (const b of list) await saveEntries(b.session, b.entries);
}

async function saveSession(session: CaptureSession) {
  await store.putSession(session);
  store.notify(session.id);
  queueForDesktop(session, []);
}

// ---------------------------------------------------------------- recorder (chrome.debugger)

interface Pending {
  entry: CapturedEntry;
  /** Monotonic CDP timestamp (seconds) when the request started. */
  ts: number;
}
interface Rec {
  tabId: number;
  session: CaptureSession;
  apiOnly: boolean;
  pending: Map<string, Pending>;
  /** Extra-info events can arrive before the main event; keep them until it does. */
  extraReq: Map<string, [string, string][]>;
  extraRes: Map<string, [string, string][]>;
  count: number;
}
const recs = new Map<number, Rec>();

type CdpHeaders = Record<string, string>;
interface CdpRequest {
  url: string;
  urlFragment?: string;
  method: string;
  headers: CdpHeaders;
  postData?: string;
  hasPostData?: boolean;
}
interface CdpResponse {
  url: string;
  status: number;
  statusText: string;
  headers: CdpHeaders;
  mimeType?: string;
}

const send = <T>(tabId: number, method: string, params?: Record<string, unknown>) => chrome.debugger.sendCommand({ tabId }, method, params) as Promise<unknown> as Promise<T>;

async function persistRecs() {
  await chrome.storage.session.set({ recs: [...recs.values()].map((r) => ({ tabId: r.tabId, sessionId: r.session.id, apiOnly: r.apiOnly })) });
}

async function setBadge(tabId: number, on: boolean) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'REC' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93a3f' });
  } catch {
    /* tab gone */
  }
}

async function startRecording(tabId: number, apiOnly: boolean): Promise<string> {
  const existing = recs.get(tabId);
  if (existing) return existing.session.id;
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) throw new Error('Only website tabs (http or https) can be recorded.');
  const host = new URL(tab.url).host;
  const now = Date.now();
  const session = newSession({ name: host || tab.title || 'Recording', source: 'recorder', live: true, recordingFrom: now, startedAt: now, pageUrl: tab.url });
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    throw new Error(/attached/i.test(msg) ? 'Another debugger is already attached to this tab. Close it and try again.' : msg);
  }
  await send(tabId, 'Network.enable', { maxPostDataSize: 1_000_000 });
  const rec: Rec = { tabId, session, apiOnly, pending: new Map(), extraReq: new Map(), extraRes: new Map(), count: 0 };
  recs.set(tabId, rec);
  await persistRecs();
  await setBadge(tabId, true);
  await store.putSession(session);
  // Time travel before Record: requests this tab made in the last few minutes.
  const before = rewindForTab(tabId).map((e) => ({ ...e, id: newId(), sessionId: session.id, before: true }));
  if (before.length) await saveEntries(session, before);
  else await saveSession(session);
  await store.trim();
  return session.id;
}

async function finishRecording(rec: Rec) {
  recs.delete(rec.tabId);
  await flushBatches();
  const left = [...rec.pending.values()].map((p) => ({ ...p.entry, note: p.entry.note ?? 'Still loading when recording stopped.' }));
  rec.session.live = false;
  rec.session.endedAt = Date.now();
  if (left.length) await saveEntries(rec.session, left);
  else await saveSession(rec.session);
  await persistRecs();
  await setBadge(rec.tabId, false);
}

async function stopRecording(tabId: number) {
  const rec = recs.get(tabId);
  if (!rec) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached */
  }
  await finishRecording(rec);
}

async function completeEntry(rec: Rec, requestId: string) {
  const p = rec.pending.get(requestId);
  if (!p) return;
  rec.pending.delete(requestId);
  if (rec.count >= MAX_ENTRIES) return;
  rec.count++;
  saveSoon(rec.session, p.entry);
}

function onCdpEvent(source: chrome.debugger.Debuggee, method: string, raw?: object) {
  const rec = source.tabId !== undefined ? recs.get(source.tabId) : undefined;
  if (!rec) return;
  const params = raw as Record<string, unknown> & { requestId: string; timestamp: number };
  const id = params.requestId;
  const p = rec.pending.get(id);

  switch (method) {
    case 'Network.requestWillBeSent': {
      const req = params.request as CdpRequest;
      const type = String(params.type ?? 'other').toLowerCase();
      if (rec.apiOnly && !isApiType(type)) return;
      const redirect = params.redirectResponse as CdpResponse | undefined;
      if (redirect && p) {
        // Same request id continues after a redirect: close the hop that was redirected.
        p.entry.status = redirect.status;
        p.entry.statusText = redirect.statusText;
        p.entry.responseHeaders = headerList(redirect.headers);
        p.entry.durationMs = Math.round((params.timestamp - p.ts) * 1000);
        saveSoon(rec.session, p.entry);
        rec.count++;
      }
      const entry: CapturedEntry = {
        id: newId(),
        sessionId: rec.session.id,
        startedAt: Math.round(Number(params.wallTime) * 1000) || Date.now(),
        method: req.method,
        url: req.url + (req.urlFragment ?? ''),
        type,
        requestHeaders: rec.extraReq.get(id) ?? headerList(req.headers),
        responseHeaders: [],
        pageUrl: params.documentURL as string | undefined,
      };
      rec.extraReq.delete(id);
      entry.requestBody = capBody(req.postData, entry);
      rec.pending.set(id, { entry, ts: params.timestamp });
      if (req.hasPostData && req.postData === undefined) {
        send<{ postData: string }>(rec.tabId, 'Network.getRequestPostData', { requestId: id }).then(
          (r) => (entry.requestBody = capBody(r.postData, entry)),
          () => (entry.note = 'Request body was not available.'),
        );
      }
      return;
    }
    case 'Network.requestWillBeSentExtraInfo': {
      // The headers really sent, including Cookie.
      const headers = headerList(params.headers as CdpHeaders);
      if (p) p.entry.requestHeaders = headers;
      else rec.extraReq.set(id, headers);
      return;
    }
    case 'Network.responseReceived': {
      if (!p) return;
      const res = params.response as CdpResponse;
      p.entry.status = res.status;
      p.entry.statusText = res.statusText;
      p.entry.mimeType = res.mimeType;
      p.entry.responseHeaders = rec.extraRes.get(id) ?? headerList(res.headers);
      rec.extraRes.delete(id);
      return;
    }
    case 'Network.responseReceivedExtraInfo': {
      // Raw response headers, including Set-Cookie.
      const headers = headerList(params.headers as CdpHeaders);
      if (p && p.entry.status !== undefined) p.entry.responseHeaders = headers;
      else rec.extraRes.set(id, headers);
      return;
    }
    case 'Network.loadingFinished': {
      if (!p) return;
      p.entry.durationMs = Math.round((params.timestamp - p.ts) * 1000);
      p.entry.size = Math.round(Number(params.encodedDataLength) || 0) || undefined;
      send<{ body: string; base64Encoded: boolean }>(rec.tabId, 'Network.getResponseBody', { requestId: id })
        .then(
          (r) => {
            p.entry.responseBody = capBody(r.body, p.entry);
            if (r.base64Encoded) p.entry.responseBodyBase64 = true;
          },
          () => (p.entry.note = p.entry.note ?? 'The browser did not keep this response body.'),
        )
        .finally(() => void completeEntry(rec, id));
      return;
    }
    case 'Network.loadingFailed': {
      if (!p) return;
      p.entry.durationMs = Math.round((params.timestamp - p.ts) * 1000);
      p.entry.error = params.canceled ? 'Cancelled by the page' : String(params.errorText ?? 'Failed');
      void completeEntry(rec, id);
      return;
    }
  }
}

function onCdpDetach(source: chrome.debugger.Debuggee) {
  // The user closed the "is debugging this browser" bar, or the tab closed.
  const rec = source.tabId !== undefined ? recs.get(source.tabId) : undefined;
  if (rec) void finishRecording(rec);
}

/** Guarded in case the browser withholds the API (e.g. blocked by policy). */
function registerRecorder() {
  if (!chrome.debugger || chrome.debugger.onEvent.hasListener(onCdpEvent)) return;
  chrome.debugger.onEvent.addListener(onCdpEvent);
  chrome.debugger.onDetach.addListener(onCdpDetach);
}
registerRecorder();

chrome.tabs.onRemoved.addListener((tabId) => {
  const rec = recs.get(tabId);
  if (rec) void finishRecording(rec);
});

/** After the service worker restarts, pick up recordings that are still attached. */
async function restoreRecordings() {
  if (!chrome.debugger) return;
  const saved = ((await chrome.storage.session.get('recs')).recs as { tabId: number; sessionId: string; apiOnly: boolean }[] | undefined) ?? [];
  if (!saved.length) return;
  const targets = await chrome.debugger.getTargets();
  for (const r of saved) {
    const session = await store.getSession(r.sessionId);
    if (!session) continue;
    const attached = targets.some((t) => t.tabId === r.tabId && t.attached);
    if (attached) recs.set(r.tabId, { tabId: r.tabId, session, apiOnly: r.apiOnly, pending: new Map(), extraReq: new Map(), extraRes: new Map(), count: session.entryCount });
    else {
      session.live = false;
      await saveSession(session);
    }
  }
  await persistRecs();
}
const restored = restoreRecordings();

// ---------------------------------------------------------------- rewind (webRequest)

interface Buffered {
  e: CapturedEntry;
  tabId: number;
}
let rewindOn = false;
let buffer: Buffered[] = [];
const wrPending = new Map<string, Buffered>();
let bufferTimer: ReturnType<typeof setTimeout> | undefined;

const rewindLoaded = (async () => {
  rewindOn = !!(await chrome.storage.local.get('rewindOn')).rewindOn && !!chrome.webRequest;
  buffer = ((await chrome.storage.session.get('rewindBuffer')).rewindBuffer as Buffered[] | undefined) ?? [];
})();

function pruneBuffer() {
  const cutoff = Date.now() - REWIND_MS;
  buffer = buffer.filter((b) => b.e.startedAt >= cutoff).slice(-REWIND_MAX);
}

function persistBuffer() {
  clearTimeout(bufferTimer);
  bufferTimer = setTimeout(() => void chrome.storage.session.set({ rewindBuffer: buffer }), 1000);
}

function rewindForTab(tabId: number): CapturedEntry[] {
  if (!rewindOn) return [];
  pruneBuffer();
  return buffer.filter((b) => b.tabId === tabId).map((b) => b.e);
}

function decodeRequestBody(body: chrome.webRequest.OnBeforeRequestDetails['requestBody'] | null | undefined, e: CapturedEntry): string | undefined {
  if (!body) return undefined;
  if (body.formData) {
    return Object.entries(body.formData)
      .flatMap(([k, vs]) => vs.map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'string' ? v : '[binary]')}`))
      .join('&');
  }
  if (body.raw?.length) {
    const parts = body.raw.filter((r) => r.bytes).map((r) => new Uint8Array(r.bytes!));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    try {
      return capBody(new TextDecoder('utf-8', { fatal: true }).decode(all), e);
    } catch {
      e.note = 'Request body is binary and was not kept.';
    }
  }
  return undefined;
}

let rewindReady = false;
void rewindLoaded.then(() => (rewindReady = true));
const skipRewind = (d: { tabId: number; initiator?: string; url: string }) =>
  (rewindReady && !rewindOn) || d.tabId < 0 || recs.has(d.tabId) || (d.initiator ?? '').startsWith(OWN_ORIGIN) || /^http:\/\/127\.0\.0\.1:4732\d\//.test(d.url);

const WR_FILTER: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'], types: ['xmlhttprequest'] };

function wrBefore(d: chrome.webRequest.OnBeforeRequestDetails): undefined {
  if (skipRewind(d)) return;
  const e: CapturedEntry = { id: newId(), sessionId: '', startedAt: Math.round(d.timeStamp), method: d.method, url: d.url, type: 'xhr', requestHeaders: [], responseHeaders: [], pageUrl: d.initiator };
  e.requestBody = decodeRequestBody(d.requestBody, e);
  wrPending.set(d.requestId, { e, tabId: d.tabId });
  return undefined;
}

function wrHeaders(d: chrome.webRequest.OnSendHeadersDetails) {
  const b = wrPending.get(d.requestId);
  if (b) b.e.requestHeaders = (d.requestHeaders ?? []).map((h) => [h.name, h.value ?? ''] as [string, string]);
}

function finishBuffered(requestId: string, timeStamp: number, patch: Partial<CapturedEntry>) {
  const b = wrPending.get(requestId);
  if (!b) return;
  wrPending.delete(requestId);
  Object.assign(b.e, patch, { durationMs: Math.max(0, Math.round(timeStamp - b.e.startedAt)) });
  b.e.note = b.e.note ?? 'Response body not kept: this request happened before recording. Save it as a request and send it again to see the response.';
  // The worker may have just woken up: add to the buffer only after the saved one is loaded.
  void rewindLoaded.then(() => {
    if (!rewindOn) return;
    buffer.push(b);
    pruneBuffer();
    persistBuffer();
  });
}

function wrCompleted(d: chrome.webRequest.OnCompletedDetails) {
  const headers = (d.responseHeaders ?? []).map((h) => [h.name, h.value ?? ''] as [string, string]);
  finishBuffered(d.requestId, d.timeStamp, {
    status: d.statusCode,
    statusText: d.statusLine.replace(/^HTTP\/[\d.]+\s+\d+\s*/, ''),
    responseHeaders: headers,
    mimeType: headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1]?.split(';')[0],
  });
}

function wrError(d: chrome.webRequest.OnErrorOccurredDetails) {
  finishBuffered(d.requestId, d.timeStamp, { error: d.error });
}

/** "webRequest" is optional too: it is granted when rewind is turned on and removed when it is turned off. */
function registerRewind() {
  if (!chrome.webRequest || chrome.webRequest.onBeforeRequest.hasListener(wrBefore)) return;
  chrome.webRequest.onBeforeRequest.addListener(wrBefore, WR_FILTER, ['requestBody']);
  chrome.webRequest.onSendHeaders.addListener(wrHeaders, WR_FILTER, ['requestHeaders', 'extraHeaders']);
  chrome.webRequest.onCompleted.addListener(wrCompleted, WR_FILTER, ['responseHeaders', 'extraHeaders']);
  chrome.webRequest.onErrorOccurred.addListener(wrError, WR_FILTER);
}
registerRewind();

async function setRewind(on: boolean) {
  if (on && !(await chrome.permissions.contains({ permissions: ['webRequest'], origins: ['<all_urls>'] }))) return false;
  if (on) registerRewind();
  rewindOn = on;
  await chrome.storage.local.set({ rewindOn: on });
  if (!on) {
    buffer = [];
    wrPending.clear();
    await chrome.storage.session.remove('rewindBuffer');
    // Give the permission back so the browser stops waking Restless for every request.
    await chrome.permissions.remove({ permissions: ['webRequest'] }).catch(() => false);
  }
  return on;
}

async function grabRewind(tabId?: number): Promise<string | null> {
  pruneBuffer();
  const picked = buffer.filter((b) => tabId === undefined || b.tabId === tabId);
  if (!picked.length) return null;
  let host = '';
  if (tabId !== undefined) {
    try {
      host = new URL((await chrome.tabs.get(tabId)).url ?? '').host;
    } catch {
      /* tab gone */
    }
  }
  const session = newSession({ name: `Rewind${host ? ` · ${host}` : ''}`, source: 'rewind' });
  const entries = picked.map((b) => ({ ...b.e, id: newId(), sessionId: session.id, before: true }));
  await store.putSession(session);
  await saveEntries(session, entries);
  await store.trim();
  return session.id;
}

// ---------------------------------------------------------------- DevTools panel

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'restless-devtools') return;
  let session: CaptureSession | null = null;
  port.onMessage.addListener(async (msg: { type: string; url?: string; openedAt?: number; sessionId?: string | null; entries?: CapturedEntry[] }) => {
    if (msg.type === 'start') {
      // A panel that lost its connection (the worker was stopped) continues its capture.
      const existing = msg.sessionId ? await store.getSession(msg.sessionId) : undefined;
      if (existing) {
        session = { ...existing, live: true };
        await saveSession(session);
        port.postMessage({ type: 'started', sessionId: session.id });
        return;
      }
      let host = '';
      try {
        host = new URL(msg.url ?? '').host;
      } catch {
        /* keep empty */
      }
      session = newSession({ name: `DevTools${host ? ` · ${host}` : ''}`, source: 'devtools', live: true, recordingFrom: msg.openedAt, pageUrl: msg.url });
      await saveSession(session);
      await store.trim();
      port.postMessage({ type: 'started', sessionId: session.id });
    } else if (msg.type === 'entries' && session && msg.entries?.length) {
      const s = session;
      await saveEntries(
        s,
        msg.entries.map((e) => ({ ...e, sessionId: s.id })),
      );
    }
  });
  port.onDisconnect.addListener(() => {
    if (!session) return;
    session.live = false;
    session.endedAt = Date.now();
    void saveSession(session);
  });
});

// ---------------------------------------------------------------- messages from the app and the popup

type Msg =
  | { type: 'capture:tabs' }
  | { type: 'capture:start'; tabId: number; apiOnly: boolean }
  | { type: 'capture:stop'; tabId: number }
  | { type: 'capture:recordings' }
  | { type: 'capture:rewind-status' }
  | { type: 'capture:rewind-set'; on: boolean }
  | { type: 'capture:rewind-grab'; tabId?: number }
  | { type: 'capture:desktop-status' }
  | { type: 'capture:desktop-connect'; code: string }
  | { type: 'capture:desktop-disconnect' }
  | { type: 'capture:desktop-resend'; sessionId: string }
  | { type: 'capture:tab-state'; tabId: number }
  | { type: 'capture:pending-start'; tabId: number; apiOnly: boolean }
  | { type: 'app:open'; hash?: string };

async function handle(msg: Msg): Promise<unknown> {
  await Promise.all([restored, rewindLoaded]);
  switch (msg.type) {
    case 'capture:tabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((t) => t.id !== undefined && /^https?:/.test(t.url ?? '')).map((t) => ({ id: t.id!, title: t.title ?? '', url: t.url ?? '' }));
    }
    case 'capture:start':
      await chrome.storage.session.remove('pendingStart');
      return startRecording(msg.tabId, msg.apiOnly);
    case 'capture:stop':
      return stopRecording(msg.tabId);
    case 'capture:recordings':
      return [...recs.values()].map((r) => ({ tabId: r.tabId, sessionId: r.session.id, title: r.session.name }));
    case 'capture:rewind-status':
      pruneBuffer();
      return { enabled: rewindOn, buffered: buffer.length, minutes: REWIND_MS / 60000 };
    case 'capture:rewind-set':
      return setRewind(msg.on);
    case 'capture:rewind-grab':
      return grabRewind(msg.tabId);
    case 'capture:desktop-status': {
      const link = await getLink();
      return { connected: !!link, reachable: !!link && reachable, port: link?.port };
    }
    case 'capture:desktop-connect':
      return connectDesktop(msg.code);
    case 'capture:desktop-disconnect':
      await chrome.storage.local.remove('desktopLink');
      return null;
    case 'capture:desktop-resend':
      return resendToDesktop(msg.sessionId);
    case 'capture:tab-state': {
      const rec = recs.get(msg.tabId);
      pruneBuffer();
      return {
        recording: rec ? { sessionId: rec.session.id, count: rec.count } : null,
        rewind: rewindOn,
        bufferedForTab: buffer.filter((b) => b.tabId === msg.tabId).length,
      };
    }
    case 'capture:pending-start':
      await chrome.storage.session.set({ pendingStart: { tabId: msg.tabId, apiOnly: msg.apiOnly } });
      return null;
    case 'app:open':
      return openApp(msg.hash);
  }
}

// The popup asks for the recording permission; the prompt may close the popup before it hears back,
// so the tab to record is parked here and recording starts as soon as the permission arrives.
chrome.permissions.onAdded.addListener(async () => {
  registerRecorder();
  registerRewind();
  const pending = (await chrome.storage.session.get('pendingStart')).pendingStart as { tabId: number; apiOnly: boolean } | undefined;
  if (pending && chrome.debugger) {
    await chrome.storage.session.remove('pendingStart');
    try {
      await startRecording(pending.tabId, pending.apiOnly);
    } catch {
      /* the popup shows errors when it is still open */
    }
  }
});

chrome.permissions.onRemoved.addListener(async () => {
  if (!chrome.webRequest && rewindOn) {
    rewindOn = false;
    buffer = [];
    await chrome.storage.local.set({ rewindOn: false });
  }
});

chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
  handle(msg).then(
    (result) => reply({ ok: true, result }),
    (e) => reply({ ok: false, error: (e as Error).message ?? String(e) }),
  );
  return true; // async reply
});
