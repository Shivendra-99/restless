// The Restless tab in DevTools. No extra permissions: it reads what DevTools already sees.
// When first shown it takes everything DevTools recorded since it opened (time travel back),
// then keeps adding requests as they finish. Everything lands in the Restless app as a capture.
import './pages.css';
import { harToEntry, isApiType, type CapturedEntry, type HarEntry } from '@restless/core';

type DevtoolsRequest = HarEntry & { getContent(cb: (content: string | null, encoding: string) => void): void };

const API_ONLY_KEY = 'restless.capture.apiOnly';
const openedAt = Date.now();
const entries: CapturedEntry[] = [];
let sessionId: string | null = null;
let pageUrl = '';
let paused = false;
let apiOnly = (() => {
  try {
    return localStorage.getItem(API_ONLY_KEY) !== 'false';
  } catch {
    return true;
  }
})();
let port: chrome.runtime.Port | null = null;
const queue: CapturedEntry[] = [];

// ---------------------------------------------------------------- talking to the background

function connect() {
  port = chrome.runtime.connect({ name: 'restless-devtools' });
  port.onMessage.addListener((msg: { type: string; sessionId?: string }) => {
    if (msg.type === 'started' && msg.sessionId) {
      sessionId = msg.sessionId;
      flush();
      render();
    }
  });
  // The background can be stopped by the browser when idle; reconnect and continue the same capture.
  port.onDisconnect.addListener(() => (port = null));
  port.postMessage({ type: 'start', url: pageUrl, openedAt, sessionId });
}

function flush() {
  if (!sessionId || !queue.length) return;
  if (!port) return connect();
  const batch = queue.splice(0, queue.length);
  try {
    port.postMessage({ type: 'entries', entries: batch });
  } catch {
    queue.unshift(...batch);
    port = null;
    connect();
  }
}

// ---------------------------------------------------------------- reading DevTools' network log

const seen = new Set<string>();

function add(req: DevtoolsRequest, before: boolean) {
  // A request finishing right as the panel opens can come from both getHAR and onRequestFinished.
  const key = `${req.startedDateTime}|${req.request.method}|${req.request.url}`;
  if (seen.has(key)) return;
  seen.add(key);
  const type = (req._resourceType ?? 'other').toLowerCase();
  if (apiOnly && !isApiType(type)) return;
  if (/^(data|blob|chrome-extension):/.test(req.request.url)) return;
  req.getContent((content, encoding) => {
    const e = harToEntry(req, sessionId ?? '', { text: content, encoding });
    if (before) e.before = true;
    entries.push(e);
    queue.push(e);
    flush();
    render();
  });
}

function start() {
  chrome.devtools.inspectedWindow.eval<string>('location.href', (href) => {
    pageUrl = typeof href === 'string' ? href : '';
    connect();
    chrome.devtools.network.getHAR((log) => {
      for (const h of (log?.entries ?? []) as unknown as DevtoolsRequest[]) add(h, true);
    });
    chrome.devtools.network.onRequestFinished.addListener((req) => {
      if (!paused) add(req as unknown as DevtoolsRequest, false);
    });
    chrome.devtools.network.onNavigated.addListener((url) => (pageUrl = url));
  });
}

// ---------------------------------------------------------------- UI

type Props = Record<string, unknown>;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) if (c !== null) node.append(c);
  return node;
}

const root = document.getElementById('root')!;
let rows: HTMLDivElement | null = null;
let renderQueued = false;

function statusClass(e: CapturedEntry) {
  if (e.error || !e.status) return 's0';
  return `s${String(e.status)[0]}`;
}

function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const atBottom = !rows || rows.scrollTop + rows.clientHeight >= rows.scrollHeight - 8;
    const sorted = [...entries].sort((a, b) => a.startedAt - b.startedAt);
    const beforeCount = sorted.filter((e) => e.before).length;
    const t0 = sorted[0]?.startedAt ?? openedAt;

    const apiBox = el('input', { type: 'checkbox', checked: apiOnly });
    apiBox.addEventListener('change', () => {
      apiOnly = apiBox.checked;
      try {
        localStorage.setItem(API_ONLY_KEY, String(apiOnly));
      } catch {
        /* not kept */
      }
    });

    const bar = el(
      'div',
      { className: 'bar' },
      el('span', { className: 'status' }, el('span', { className: `dot ${paused ? '' : 'on'}` }), paused ? 'Paused' : 'Capturing this tab'),
      el('span', { className: 'muted small' }, `${entries.length} ${entries.length === 1 ? 'request' : 'requests'}${beforeCount ? `, ${beforeCount} from before you opened this tab` : ''}`),
      el('span', { className: 'grow' }),
      el('label', { className: 'check', title: 'Applies to requests from now on' }, apiBox, 'API calls only'),
      el(
        'button',
        {
          className: 'btn',
          onclick: () => {
            paused = !paused;
            render();
          },
        },
        paused ? 'Resume' : 'Pause',
      ),
      el(
        'button',
        {
          className: 'btn primary',
          disabled: !sessionId,
          onclick: () => void chrome.runtime.sendMessage({ type: 'app:open', hash: sessionId ? `#capture=${sessionId}` : '#capture' }),
        },
        'Open in Restless',
      ),
    );

    rows = el('div', { className: 'rows' });
    if (!sorted.length) {
      rows.append(
        el('p', { className: 'empty' }, 'Use the page and its API calls will show up here. Everything DevTools saw since it opened is included, and it all appears in Restless under Capture, where you can step through it on a timeline and save any call as a request.'),
      );
    }
    let splitShown = false;
    for (const e of sorted) {
      if (beforeCount && !splitShown && !e.before) {
        rows.append(el('div', { className: 'split' }, 'You opened the Restless tab here'));
        splitShown = true;
      }
      let path = e.url;
      try {
        const u = new URL(e.url);
        path = `${u.pathname}${u.search}`;
      } catch {
        /* keep as is */
      }
      rows.append(
        el(
          'div',
          { className: `row ${e.before ? 'before' : ''}`, title: e.url },
          el('span', { className: 'r' }, `+${((e.startedAt - t0) / 1000).toFixed(1)}s`),
          el('span', {}, e.method),
          el('span', { className: statusClass(e) }, e.error ? 'ERR' : String(e.status ?? '…')),
          el('span', { className: 'path' }, path),
          el('span', { className: 'r' }, e.durationMs !== undefined ? `${e.durationMs} ms` : ''),
        ),
      );
    }
    root.replaceChildren(bar, rows);
    if (atBottom) rows.scrollTop = rows.scrollHeight;
  });
}

render();
start();
