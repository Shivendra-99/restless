import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CapturedEntry, CaptureSession, McpServerConfig, ResolvedRequest, Workspace } from '@restless/core';
import { CaptureServer } from './capture-server';
import { CaptureStore } from './capture-store';
import { sendHttp } from './http-engine';
import { McpManager } from './mcp-manager';
import { FileWorkspaceStore, type SecretStore } from './storage';
import { fixPathFromLoginShell } from './shell-path';

fixPathFromLoginShell();

let win: BrowserWindow | null = null;
let store: FileWorkspaceStore;
let httpAbort: AbortController | null = null;
let saving: Promise<void> = Promise.resolve();
let quitting = false;
let captures: CaptureStore;
let captureServer: CaptureServer;
const configFile = () => path.join(app.getPath('userData'), 'config.json');

const secretStore: SecretStore = {
  get available() {
    return safeStorage.isEncryptionAvailable();
  },
  encrypt(plain) {
    // Uses Keychain (macOS), DPAPI (Windows) or libsecret/kwallet (Linux).
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(plain).toString('base64')}`;
    return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`;
  },
  decrypt(cipher) {
    if (cipher.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(cipher.slice(4), 'base64'));
    if (cipher.startsWith('plain:')) return Buffer.from(cipher.slice(6), 'base64').toString('utf8');
    throw new Error('Unknown secret format');
  },
};

async function readConfig(): Promise<{ workspacePath?: string }> {
  try {
    return JSON.parse(await fs.readFile(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeConfig(cfg: { workspacePath?: string }) {
  await fs.mkdir(path.dirname(configFile()), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(cfg, null, 2));
}

const mcp = new McpManager((entry) => {
  if (win && !win.isDestroyed()) win.webContents.send('mcp:log', entry);
});

const captureChanged = (sessionId: string | null) => {
  if (win && !win.isDestroyed()) win.webContents.send('capture:changed', sessionId);
};

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    title: 'Restless',
    backgroundColor: '#1b2230',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('http:send', async (_e, req: ResolvedRequest) => {
    httpAbort?.abort();
    httpAbort = new AbortController();
    try {
      return await sendHttp(req, { signal: httpAbort.signal });
    } finally {
      httpAbort = null;
    }
  });
  ipcMain.handle('http:cancel', () => httpAbort?.abort());

  ipcMain.handle('mcp:connect', (_e, cfg: McpServerConfig) => mcp.connect(cfg));
  ipcMain.handle('mcp:catalog', (_e, id: string) => mcp.catalog(id));
  ipcMain.handle('mcp:call', (_e, id: string, name: string, args: Record<string, unknown>) => mcp.callTool(id, name, args));
  ipcMain.handle('mcp:read', (_e, id: string, uri: string) => mcp.readResource(id, uri));
  ipcMain.handle('mcp:prompt', (_e, id: string, name: string, args: Record<string, string>) => mcp.getPrompt(id, name, args));
  ipcMain.handle('mcp:ping', (_e, id: string) => mcp.ping(id));
  ipcMain.handle('mcp:disconnect', (_e, id: string) => mcp.disconnect(id));

  ipcMain.handle('ws:load', () => store.load());
  ipcMain.handle('ws:save', (_e, ws: Workspace) => {
    // One write at a time, and remembered so quitting can wait for it.
    const run = saving.then(() => store.save(ws));
    saving = run.catch(() => {});
    return run;
  });
  ipcMain.handle('ws:location', () => store.root);
  ipcMain.handle('file:save', async (_e, suggestedName: string, text: string) => {
    const name = path.basename(String(suggestedName));
    const har = name.toLowerCase().endsWith('.har');
    const res = await dialog.showSaveDialog(win!, {
      title: har ? 'Export capture' : 'Export collection',
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: har ? [{ name: 'HAR file', extensions: ['har'] }] : [{ name: 'Postman collection', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.writeFile(res.filePath, String(text), 'utf8');
    return res.filePath;
  });
  ipcMain.handle('capture:list', () => captures.list());
  ipcMain.handle('capture:entries', (_e, id: string) => captures.entries(String(id)));
  ipcMain.handle('capture:delete', async (_e, id: string) => {
    await captures.delete(String(id));
    captureChanged(null);
  });
  ipcMain.handle('capture:import', async (_e, session: CaptureSession, entries: CapturedEntry[]) => {
    await captures.put(session, entries);
    captureChanged(session.id);
  });
  ipcMain.handle('capture:pair-code', () => captureServer.newCode());
  ipcMain.handle('capture:browsers', () => captureServer.listBrowsers());
  ipcMain.handle('capture:browser-remove', (_e, id: string) => captureServer.removeBrowser(String(id)));

  ipcMain.handle('ws:choose', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Open or create a Restless workspace folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    store = new FileWorkspaceStore(res.filePaths[0], app.getPath('userData'), secretStore);
    await writeConfig({ workspacePath: res.filePaths[0] });
    return res.filePaths[0];
  });
}

app.whenReady().then(async () => {
  const cfg = await readConfig();
  const root = process.env.RESTLESS_WORKSPACE || cfg.workspacePath || path.join(app.getPath('documents'), 'Restless');
  store = new FileWorkspaceStore(root, app.getPath('userData'), secretStore);
  captures = new CaptureStore(path.join(app.getPath('userData'), 'captures'));
  await captures.closeStale();
  captureServer = new CaptureServer(captures, path.join(app.getPath('userData'), 'capture-browsers.json'), app.getVersion(), captureChanged);
  await captureServer.start();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  // Close windows first: each page flushes its pending save while unloading. Then wait for those
  // writes (and stop MCP servers) before exiting, so the last edit is never lost.
  const closing = BrowserWindow.getAllWindows().map((w) => new Promise<void>((done) => (w.once('closed', () => done()), w.close())));
  void Promise.all(closing)
    .then(() => new Promise((r) => setTimeout(r, 50)))
    .then(() => (captureServer?.stop(), Promise.allSettled([saving, mcp.closeAll()])))
    .then(() => app.quit());
});
