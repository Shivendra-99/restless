import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { McpSession } from '@restless/core/mcp';
import { emptyWorkspace, type Bridge, type CaptureBridge, type KeyValue, type McpLogEntry, type Workspace } from '@restless/core';
import { cancel, ensureHostAccess, sendViaFetch } from './fetch-engine';
import * as store from './capture-db';

/** Ask the service worker; it answers { ok, result } or { ok: false, error }. */
async function ask<T>(msg: object): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; result?: T; error?: string } | undefined;
  if (!res) throw new Error('Restless background did not answer. Reload the extension and try again.');
  if (!res.ok) throw new Error(res.error ?? 'Something went wrong');
  return res.result as T;
}

const RECORD_PERMS: chrome.permissions.Permissions = { permissions: ['debugger', 'tabs'] };
const REWIND_PERMS: chrome.permissions.Permissions = { permissions: ['webRequest'], origins: ['<all_urls>'] };
const DESKTOP_PERMS: chrome.permissions.Permissions = { origins: ['http://127.0.0.1/*'] };

// chrome.permissions.request must be the first thing a click does, before any await.
const capture: CaptureBridge = {
  listSessions: store.listSessions,
  getEntries: store.getEntries,
  async deleteSession(id) {
    await store.deleteSession(id);
    store.notify(null);
  },
  async importSession(session, entries) {
    await store.putSession(session);
    await store.putEntries(session, entries);
    store.notify(session.id);
    await store.trim();
  },
  onChange(cb) {
    const ch = new BroadcastChannel(store.CHANNEL);
    ch.onmessage = (e: MessageEvent<{ sessionId: string | null }>) => cb(e.data?.sessionId ?? null);
    return () => ch.close();
  },
  ensureRecordAccess: () => chrome.permissions.request(RECORD_PERMS),
  listTabs: () => ask({ type: 'capture:tabs' }),
  startRecording: (tabId, { apiOnly }) => ask({ type: 'capture:start', tabId, apiOnly }),
  stopRecording: (tabId) => ask({ type: 'capture:stop', tabId }),
  recordings: () => ask({ type: 'capture:recordings' }),
  rewindStatus: () => ask({ type: 'capture:rewind-status' }),
  async setRewind(on) {
    if (on && !(await chrome.permissions.request(REWIND_PERMS))) return false;
    return ask({ type: 'capture:rewind-set', on });
  },
  grabRewind: (tabId) => ask({ type: 'capture:rewind-grab', tabId }),
  desktop: {
    status: () => ask({ type: 'capture:desktop-status' }),
    async connect(code) {
      if (!(await chrome.permissions.request(DESKTOP_PERMS))) throw new Error('Restless needs permission to talk to the desktop app on this computer (127.0.0.1).');
      await ask({ type: 'capture:desktop-connect', code });
    },
    disconnect: () => ask({ type: 'capture:desktop-disconnect' }),
    resend: (sessionId) => ask({ type: 'capture:desktop-resend', sessionId }),
  },
};

const KEY = 'restless.workspace.v1';
const kvToRecord = (list: KeyValue[] | undefined) => Object.fromEntries((list ?? []).filter((k) => k.enabled && k.key).map((k) => [k.key, k.value]));

const sessions = new Map<string, McpSession>();
const listeners = new Set<(e: McpLogEntry) => void>();
const emit = (e: McpLogEntry) => listeners.forEach((l) => l(e));
let counter = 0;

const get = (id: string) => {
  const s = sessions.get(id);
  if (!s) throw new Error('This MCP session is no longer connected. Connect again.');
  return s;
};

export const extensionBridge: Bridge = {
  platform: 'extension',
  capabilities: { stdio: false, forbiddenHeaders: true, detailedTimings: false, fileWorkspace: false },
  sendHttp: sendViaFetch,
  cancelHttp: cancel,
  mcp: {
    async connect(cfg) {
      if (cfg.transport === 'stdio') throw new Error('stdio servers need the Restless desktop app: a browser extension cannot start local processes.');
      if (!cfg.url) throw new Error('Enter the server URL');
      let url: URL;
      try {
        url = new URL(cfg.url);
      } catch {
        throw new Error(`Invalid URL: ${cfg.url}`);
      }
      await ensureHostAccess(url.href);
      const headers = kvToRecord(cfg.headers);
      const transport =
        cfg.transport === 'http'
          ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
          : new SSEClientTransport(url, {
              requestInit: { headers },
              eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) },
            });
      const id = `${cfg.id}:${++counter}`;
      // Ajv (the SDK default) needs eval, which MV3 extensions block; this validator doesn't.
      const session = new McpSession(id, transport, emit, { validator: new CfWorkerJsonSchemaValidator() });
      session.push('info', `Connecting to ${cfg.url} (${cfg.transport})`);
      try {
        const info = await session.connect();
        sessions.set(id, session);
        return info;
      } catch (e) {
        await session.close();
        throw e;
      }
    },
    catalog: (id) => get(id).catalog(),
    callTool: (id, name, args) => get(id).callTool(name, args),
    readResource: (id, uri) => get(id).readResource(uri),
    getPrompt: (id, name, args) => get(id).getPrompt(name, args),
    ping: (id) => get(id).ping(),
    async disconnect(id) {
      const s = sessions.get(id);
      sessions.delete(id);
      await s?.close();
    },
    onLog(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  },
  storage: {
    async load(): Promise<Workspace> {
      const got = await chrome.storage.local.get(KEY);
      return { ...emptyWorkspace('Browser workspace'), ...((got[KEY] as Workspace | undefined) ?? {}) };
    },
    async save(ws) {
      await chrome.storage.local.set({ [KEY]: ws });
    },
    async location() {
      return 'Stored in this browser profile only';
    },
  },
  capture,
};
