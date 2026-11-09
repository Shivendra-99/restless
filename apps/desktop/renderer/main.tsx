import { createRoot } from 'react-dom/client';
import { App } from '@restless/ui';
import type { Bridge, McpLogEntry } from '@restless/core';

interface Native {
  platform: string;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  onMcpLog(cb: (e: McpLogEntry) => void): () => void;
  onCaptureChange(cb: (sessionId: string | null) => void): () => void;
}
const native = (window as unknown as { restlessNative: Native }).restlessNative;

// Electron prefixes errors with "Error invoking remote method 'x': Error: ". Keep only the message.
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await native.invoke<T>(channel, ...args);
  } catch (e) {
    const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
    throw new Error(msg);
  }
}

const bridge: Bridge = {
  platform: 'desktop',
  capabilities: { stdio: true, forbiddenHeaders: true, detailedTimings: true, fileWorkspace: true },
  sendHttp: (req) => call('http:send', req),
  cancelHttp: () => void call('http:cancel'),
  mcp: {
    connect: (cfg) => call('mcp:connect', cfg),
    catalog: (id) => call('mcp:catalog', id),
    callTool: (id, name, args) => call('mcp:call', id, name, args),
    readResource: (id, uri) => call('mcp:read', id, uri),
    getPrompt: (id, name, args) => call('mcp:prompt', id, name, args),
    ping: (id) => call('mcp:ping', id),
    disconnect: (id) => call('mcp:disconnect', id),
    onLog: (cb) => native.onMcpLog(cb),
  },
  saveFile: (name, text) => call('file:save', name, text),
  // Captures arrive from the browser extension over a paired local connection.
  capture: {
    listSessions: () => call('capture:list'),
    getEntries: (id) => call('capture:entries', id),
    deleteSession: (id) => call('capture:delete', id),
    importSession: (session, entries) => call('capture:import', session, entries),
    onChange: (cb) => native.onCaptureChange(cb),
    pairing: {
      newCode: () => call('capture:pair-code'),
      browsers: () => call('capture:browsers'),
      remove: (id) => call('capture:browser-remove', id),
    },
  },
  storage: {
    load: () => call('ws:load'),
    save: (ws) => call('ws:save', ws),
    location: () => call('ws:location'),
    chooseFolder: () => call('ws:choose'),
  },
};

createRoot(document.getElementById('root')!).render(<App bridge={bridge} />);
