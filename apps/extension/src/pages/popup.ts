// Toolbar popup: open the app, record the current tab, or grab the last few minutes.
import './pages.css';

interface TabState {
  recording: { sessionId: string; count: number } | null;
  rewind: boolean;
  bufferedForTab: number;
}

const RECORD_PERMS: chrome.permissions.Permissions = { permissions: ['debugger', 'tabs'] };
const API_ONLY_KEY = 'restless.capture.apiOnly';

async function ask<T>(msg: object): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; result?: T; error?: string } | undefined;
  if (!res?.ok) throw new Error(res?.error ?? 'Restless did not answer. Reload the extension.');
  return res.result as T;
}

type Props = Record<string, unknown>;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) if (c !== null) node.append(c);
  return node;
}

const root = document.getElementById('root')!;
let error = '';

const readApiOnly = () => {
  try {
    return localStorage.getItem(API_ONLY_KEY) !== 'false';
  } catch {
    return true;
  }
};

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  let host = '';
  try {
    host = tab?.url ? new URL(tab.url).host : '';
  } catch {
    /* not a web page */
  }
  const webPage = !tab?.url || /^https?:/.test(tab.url);
  const state = tabId !== undefined ? await ask<TabState>({ type: 'capture:tab-state', tabId }).catch(() => null) : null;

  const open = (hash = '') => void ask({ type: 'app:open', hash }).then(() => window.close());

  const parts: (Node | null)[] = [
    el('div', { className: 'head' }, el('img', { src: 'icons/icon-32.png', alt: '' }), el('strong', {}, 'Restless'), host ? el('span', { className: 'host', title: host }, host) : null),
    el('button', { className: 'btn primary', onclick: () => open() }, 'Open Restless'),
    el('hr'),
  ];

  if (state?.recording) {
    const rec = state.recording;
    parts.push(
      el(
        'button',
        {
          className: 'btn rec',
          onclick: async () => {
            await ask({ type: 'capture:stop', tabId });
            void render();
          },
        },
        el('span', { className: 'dot on' }),
        'Stop recording',
        el('span', { className: 'sub' }, `${rec.count} ${rec.count === 1 ? 'call' : 'calls'}`),
      ),
      el('button', { className: 'btn', onclick: () => open(`#capture=${rec.sessionId}`) }, 'Watch it in Restless'),
    );
  } else {
    const apiOnly = el('input', { type: 'checkbox', checked: readApiOnly() });
    apiOnly.addEventListener('change', () => {
      try {
        localStorage.setItem(API_ONLY_KEY, String(apiOnly.checked));
      } catch {
        /* not kept */
      }
    });
    parts.push(
      el(
        'button',
        {
          className: 'btn',
          disabled: !webPage || tabId === undefined,
          title: webPage ? 'Capture every API call this tab makes, with responses' : 'Only website tabs can be recorded',
          onclick: () => {
            if (tabId === undefined) return;
            // The permission prompt can close this popup before it answers, so tell the background
            // which tab to record first; it starts as soon as the permission is granted.
            void chrome.runtime.sendMessage({ type: 'capture:pending-start', tabId, apiOnly: apiOnly.checked });
            chrome.permissions.request(RECORD_PERMS).then(async (ok) => {
              if (!ok) {
                error = 'Recording needs permission to debug this tab.';
                return void render();
              }
              try {
                await ask({ type: 'capture:start', tabId, apiOnly: apiOnly.checked });
                error = '';
              } catch (e) {
                error = (e as Error).message;
              }
              void render();
            });
          },
        },
        el('span', { className: 'dot' }),
        'Record this tab',
      ),
      el('label', { className: 'check' }, apiOnly, 'Only API calls (fetch/XHR)'),
    );
  }

  if (state?.rewind && state.bufferedForTab > 0 && !state.recording) {
    parts.push(
      el(
        'button',
        {
          className: 'btn',
          title: 'Turn the API calls this tab made in the last 5 minutes into a capture',
          onclick: async () => {
            const id = await ask<string | null>({ type: 'capture:rewind-grab', tabId });
            if (id) open(`#capture=${id}`);
          },
        },
        '⏪ Grab the last 5 minutes',
        el('span', { className: 'sub' }, `${state.bufferedForTab} ${state.bufferedForTab === 1 ? 'call' : 'calls'}`),
      ),
    );
  }

  if (error) parts.push(el('p', { className: 'err' }, error));
  parts.push(el('p', { className: 'tip' }, 'Prefer DevTools? Press F12 and open the Restless tab.'));
  root.replaceChildren(...parts.filter((p): p is Node => p !== null));
}

void render();
// Keep the call count fresh while the popup is open.
setInterval(() => void render(), 1500);
