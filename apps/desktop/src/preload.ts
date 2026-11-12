// Runs in a sandboxed preload. Exposes a tiny, allow-listed IPC surface; the page gets no Node access.
import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = new Set([
  'http:send', 'http:cancel',
  'mcp:connect', 'mcp:catalog', 'mcp:call', 'mcp:read', 'mcp:prompt', 'mcp:ping', 'mcp:disconnect',
  'ws:load', 'ws:save', 'ws:location', 'ws:choose', 'file:save', 'upload:pick', 'oauth:authorize',
  'capture:list', 'capture:entries', 'capture:delete', 'capture:import',
  'capture:browser-open', 'capture:browser-status', 'capture:browser-pause', 'capture:browser-new', 'capture:browser-clear',
]);

contextBridge.exposeInMainWorld('restlessNative', {
  platform: process.platform,
  invoke(channel: string, ...args: unknown[]) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`Blocked IPC channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  onMcpLog(cb: (entry: unknown) => void) {
    const listener = (_e: unknown, entry: unknown) => cb(entry);
    ipcRenderer.on('mcp:log', listener);
    return () => ipcRenderer.removeListener('mcp:log', listener);
  },
  onCaptureChange(cb: (sessionId: string | null) => void) {
    const listener = (_e: unknown, sessionId: string | null) => cb(sessionId);
    ipcRenderer.on('capture:changed', listener);
    return () => ipcRenderer.removeListener('capture:changed', listener);
  },
  onCaptureReveal(cb: (sessionId: string) => void) {
    const listener = (_e: unknown, sessionId: string) => cb(sessionId);
    ipcRenderer.on('capture:reveal', listener);
    return () => ipcRenderer.removeListener('capture:reveal', listener);
  },
});
