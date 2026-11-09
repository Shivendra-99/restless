import { createRoot } from 'react-dom/client';
import { App } from '@probe/ui';
import type { Bridge, McpLogEntry } from '@probe/core';

interface Native {
  platform: string;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  onMcpLog(cb: (e: McpLogEntry) => void): () => void;
}
const native = (window as unknown as { probeNative: Native }).probeNative;

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
  storage: {
    load: () => call('ws:load'),
    save: (ws) => call('ws:save', ws),
    location: () => call('ws:location'),
    chooseFolder: () => call('ws:choose'),
  },
};

createRoot(document.getElementById('root')!).render(<App bridge={bridge} />);
