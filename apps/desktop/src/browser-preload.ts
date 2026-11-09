// Preload for the Restless browser's toolbar (not the web page, which gets no preload at all).
import { contextBridge, ipcRenderer } from 'electron';

const COMMANDS = new Set(['navigate', 'back', 'forward', 'reload', 'stop', 'pause', 'devtools', 'show-app']);

contextBridge.exposeInMainWorld('restlessBrowser', {
  command(cmd: string, arg?: unknown) {
    if (COMMANDS.has(cmd)) ipcRenderer.send('browser:command', cmd, arg);
  },
  onState(cb: (state: unknown) => void) {
    ipcRenderer.on('browser:state', (_e, state) => cb(state));
  },
  onFocusAddress(cb: () => void) {
    ipcRenderer.on('browser:focus-address', () => cb());
  },
});
