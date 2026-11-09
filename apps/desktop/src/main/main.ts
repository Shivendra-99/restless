import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServerConfig, ResolvedRequest, Workspace } from '@restless/core';
import { sendHttp } from './http-engine';
import { McpManager } from './mcp-manager';
import { FileWorkspaceStore, type SecretStore } from './storage';
import { fixPathFromLoginShell } from './shell-path';

fixPathFromLoginShell();

let win: BrowserWindow | null = null;
let store: FileWorkspaceStore;
let httpAbort: AbortController | null = null;
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
  ipcMain.handle('ws:save', (_e, ws: Workspace) => store.save(ws));
  ipcMain.handle('ws:location', () => store.root);
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
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void mcp.closeAll();
});
