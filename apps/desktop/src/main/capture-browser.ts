// The Restless browser: a window with a small toolbar and a web page that records every API call
// (fetch/XHR) and page load the page makes, through the Chrome DevTools Protocol of its own
// webContents. No extension, no proxy, no certificate. Everything since the window opened is kept,
// which is what lets the timeline go back in time.
//
// It has its own cookie jar (persist:restless-browser), separate from Restless's own pages, so
// logins survive restarts and can be cleared from the Capture menu.
import { BaseWindow, BrowserWindow, Menu, WebContentsView, app, clipboard, session as electronSession, shell, type WebContents } from 'electron';
import path from 'node:path';
import { capBody, headerList, newId, newSession, normalizeAddress as normalizeUrl, type CaptureBrowserStatus, type CapturedEntry, type CaptureSession } from '@restless/core';
import type { CaptureStore } from './capture-store';

const PARTITION = 'persist:restless-browser';
const TOOLBAR_H = 46;
const MAX_ENTRIES = 5000;
/** API calls and page loads; scripts, images, styles and fonts are left out. */
const RECORDED_TYPES = new Set(['Fetch', 'XHR', 'Document', 'EventSource']);
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

export interface ToolbarState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  paused: boolean;
  count: number;
}

interface Pending {
  entry: CapturedEntry;
  /** CDP monotonic timestamp (seconds) when the request started. */
  ts: number;
}

/** Records one webContents (the main page or a popup it opened). */
class Recorder {
  private pending = new Map<string, Pending>();
  private extraReq = new Map<string, [string, string][]>();
  private extraRes = new Map<string, [string, string][]>();
  /** Resolves once Network events are on, so the first page load isn't missed. */
  ready: Promise<void> = Promise.resolve();

  constructor(
    private wc: WebContents,
    private owner: CaptureBrowser,
  ) {}

  attach() {
    this.ready = this.start();
  }

  private async start() {
    try {
      this.wc.debugger.attach('1.3');
    } catch {
      return; // already attached
    }
    this.wc.debugger.on('message', (_e, method, params) => this.onEvent(method, params));
    await this.wc.debugger.sendCommand('Network.enable', { maxPostDataSize: 1_000_000 });
  }

  /** Requests still in flight, e.g. when a new capture starts or the window closes. */
  drain(note: string): CapturedEntry[] {
    const left = [...this.pending.values()].map((p) => ({ ...p.entry, note: p.entry.note ?? note }));
    this.pending.clear();
    return left;
  }

  private send<T>(method: string, params: Record<string, unknown>) {
    return this.wc.debugger.sendCommand(method, params) as Promise<T>;
  }

  private finish(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.owner.record(p.entry);
  }

  private onEvent(method: string, raw: Record<string, unknown>) {
    const id = raw.requestId as string;
    const p = this.pending.get(id);
    const ts = Number(raw.timestamp);
    switch (method) {
      case 'Network.requestWillBeSent': {
        if (this.owner.paused) return;
        const type = String(raw.type ?? 'Other');
        if (!RECORDED_TYPES.has(type)) return;
        const req = raw.request as { url: string; urlFragment?: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean };
        if (!/^https?:/.test(req.url)) return;
        const redirect = raw.redirectResponse as { status: number; statusText: string; headers: Record<string, string> } | undefined;
        if (redirect && p) {
          // The same request id continues after a redirect: close the hop that was redirected.
          p.entry.status = redirect.status;
          p.entry.statusText = redirect.statusText;
          p.entry.responseHeaders = headerList(redirect.headers);
          p.entry.durationMs = Math.round((ts - p.ts) * 1000);
          this.finish(id);
        }
        const entry: CapturedEntry = {
          id: newId(),
          sessionId: '',
          startedAt: Math.round(Number(raw.wallTime) * 1000) || Date.now(),
          method: req.method,
          url: req.url + (req.urlFragment ?? ''),
          type: type.toLowerCase(),
          requestHeaders: this.extraReq.get(id) ?? headerList(req.headers),
          responseHeaders: [],
          pageUrl: raw.documentURL as string | undefined,
        };
        this.extraReq.delete(id);
        entry.requestBody = capBody(req.postData, entry);
        this.pending.set(id, { entry, ts });
        if (req.hasPostData && req.postData === undefined) {
          this.send<{ postData: string }>('Network.getRequestPostData', { requestId: id }).then(
            (r) => (entry.requestBody = capBody(r.postData, entry)),
            () => (entry.note = 'Request body was not available.'),
          );
        }
        return;
      }
      case 'Network.requestWillBeSentExtraInfo': {
        // The headers really sent, including Cookie.
        const headers = headerList(raw.headers as Record<string, string>);
        if (p) p.entry.requestHeaders = headers;
        else if (this.extraReq.size < 500) this.extraReq.set(id, headers);
        return;
      }
      case 'Network.responseReceived': {
        if (!p) return;
        const res = raw.response as { status: number; statusText: string; headers: Record<string, string>; mimeType?: string };
        p.entry.status = res.status;
        p.entry.statusText = res.statusText;
        p.entry.mimeType = res.mimeType;
        p.entry.responseHeaders = this.extraRes.get(id) ?? headerList(res.headers);
        this.extraRes.delete(id);
        return;
      }
      case 'Network.responseReceivedExtraInfo': {
        // Raw response headers, including Set-Cookie.
        const headers = headerList(raw.headers as Record<string, string>);
        if (p && p.entry.status !== undefined) p.entry.responseHeaders = headers;
        else if (this.extraRes.size < 500) this.extraRes.set(id, headers);
        return;
      }
      case 'Network.loadingFinished': {
        if (!p) return;
        p.entry.durationMs = Math.round((ts - p.ts) * 1000);
        p.entry.size = Math.round(Number(raw.encodedDataLength) || 0) || undefined;
        this.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: id })
          .then(
            (r) => {
              p.entry.responseBody = capBody(r.body, p.entry);
              if (r.base64Encoded) p.entry.responseBodyBase64 = true;
            },
            () => (p.entry.note = p.entry.note ?? 'The browser did not keep this response body.'),
          )
          .finally(() => this.finish(id));
        return;
      }
      case 'Network.loadingFailed': {
        if (!p) return;
        p.entry.durationMs = Math.round((ts - p.ts) * 1000);
        p.entry.error = raw.canceled ? 'Cancelled by the page' : String(raw.errorText ?? 'Failed');
        this.finish(id);
        return;
      }
    }
  }
}

export class CaptureBrowser {
  paused = false;
  private win: BaseWindow | null = null;
  private toolbar: WebContentsView | null = null;
  private page: WebContentsView | null = null;
  private recorders = new Map<WebContents, Recorder>();
  private session: CaptureSession | null = null;
  private named = false;
  private batch: CapturedEntry[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionReady = false;

  constructor(
    private store: CaptureStore,
    private opts: {
      rendererDir: string;
      toolbarPreload: string;
      icon?: string;
      onChange: (sessionId: string | null) => void;
      /** Bring the main window forward showing this capture. */
      reveal: (sessionId: string) => void;
    },
  ) {}

  /** The toolbar of the browser window, so IPC from anything else is ignored. */
  isToolbar(wc: WebContents) {
    return !!this.toolbar && wc === this.toolbar.webContents;
  }

  status(): CaptureBrowserStatus {
    return {
      open: !!this.win,
      sessionId: this.win ? (this.session?.id ?? null) : null,
      url: this.page?.webContents.getURL() ?? '',
      paused: this.paused,
    };
  }

  async open(url?: string): Promise<string> {
    if (!this.win) this.create();
    if (!this.session) await this.startSession();
    const target = url ? normalizeUrl(url) : null;
    if (target) await this.navigate(target);
    else if (!this.page!.webContents.getURL()) this.toolbar!.webContents.send('browser:focus-address');
    this.win!.show();
    this.win!.focus();
    return this.session!.id;
  }

  async navigate(input: string) {
    const url = normalizeUrl(input);
    if (!url || !this.page) return;
    if (!this.named && this.session) this.rename(url);
    // Network events must be on before the first load. A view that never loaded anything has no
    // renderer yet and can hold the enable call until it does, so don't wait forever.
    const ready = this.recorders.get(this.page.webContents)?.ready.catch(() => {});
    await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
    try {
      await this.page.webContents.loadURL(url);
    } catch {
      /* the page shows Chromium's own error; the failed request is in the capture */
    }
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.pushState();
    this.opts.onChange(this.session?.id ?? null);
  }

  async newCapture(): Promise<string> {
    await this.endSession('Still loading when this capture ended.');
    await this.startSession();
    const current = this.page?.webContents.getURL();
    if (current && /^https?:/.test(current)) this.rename(current);
    this.pushState();
    return this.session!.id;
  }

  async clearData() {
    const ses = electronSession.fromPartition(PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  }

  close() {
    this.win?.close();
  }

  // ------------------------------------------------------------------ toolbar commands

  command(cmd: string, arg?: unknown) {
    const wc = this.page?.webContents;
    if (!wc) return;
    switch (cmd) {
      case 'navigate':
        return void this.navigate(String(arg ?? ''));
      case 'back':
        return wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack();
      case 'forward':
        return wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward();
      case 'reload':
        return wc.reload();
      case 'stop':
        return wc.stop();
      case 'pause':
        return this.setPaused(!!arg);
      case 'devtools':
        return wc.openDevTools({ mode: 'detach' });
      case 'show-app':
        if (this.session) this.opts.reveal(this.session.id);
        return;
    }
  }

  // ------------------------------------------------------------------ recording

  record(entry: CapturedEntry) {
    if (!this.session || this.session.entryCount + this.batch.length >= MAX_ENTRIES) return;
    this.batch.push({ ...entry, sessionId: this.session.id });
    this.batchTimer ??= setTimeout(() => void this.flush(), 150);
  }

  private async flush() {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    const session = this.session;
    if (!session || !this.sessionReady) return;
    const list = this.batch.splice(0, this.batch.length);
    if (!list.length) return;
    const saved = await this.store.put(session, list);
    session.entryCount = saved.entryCount;
    session.startedAt = saved.startedAt;
    session.endedAt = saved.endedAt;
    this.opts.onChange(session.id);
    this.pushState();
  }

  private async startSession() {
    this.session = newSession({ name: 'Restless browser', source: 'browser', live: true });
    this.named = false;
    this.sessionReady = false;
    await this.store.put(this.session, []);
    this.sessionReady = true;
    this.opts.onChange(this.session.id);
    if (this.batch.length) await this.flush();
  }

  private async endSession(note: string) {
    const session = this.session;
    if (!session) return;
    for (const r of this.recorders.values()) for (const e of r.drain(note)) this.record(e);
    await this.flush();
    session.live = false;
    session.endedAt = Date.now();
    await this.store.put(session, []);
    this.session = null;
    this.opts.onChange(session.id);
  }

  private rename(url: string) {
    try {
      const host = new URL(url).host;
      if (!host || !this.session) return;
      this.session.name = host;
      this.session.pageUrl = url;
      this.named = true;
      void this.store.put(this.session, []).then(() => this.opts.onChange(this.session?.id ?? null));
    } catch {
      /* not a URL */
    }
  }

  private watch(wc: WebContents) {
    const rec = new Recorder(wc, this);
    this.recorders.set(wc, rec);
    rec.attach();
    wc.once('destroyed', () => {
      for (const e of rec.drain('The window closed before this finished.')) this.record(e);
      this.recorders.delete(wc);
    });
    this.harden(wc);
  }

  // ------------------------------------------------------------------ window

  private create() {
    const ses = electronSession.fromPartition(PARTITION);
    // Sites see a normal Chrome, not "Electron" (some refuse to work otherwise).
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|restless|Restless)\/\S+/g, ''));
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

    const win = new BaseWindow({ width: 1200, height: 820, minWidth: 560, minHeight: 360, title: 'Restless browser', autoHideMenuBar: true, backgroundColor: '#1b2230', icon: this.opts.icon });
    const toolbar = new WebContentsView({
      webPreferences: { preload: this.opts.toolbarPreload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const page = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    win.contentView.addChildView(page);
    win.contentView.addChildView(toolbar);
    this.win = win;
    this.toolbar = toolbar;
    this.page = page;

    const layout = () => {
      const { width, height } = win.getContentBounds();
      toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_H });
      page.setBounds({ x: 0, y: TOOLBAR_H, width, height: Math.max(0, height - TOOLBAR_H) });
    };
    layout();
    win.on('resize', layout);

    toolbar.webContents.on('will-navigate', (e) => e.preventDefault());
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void toolbar.webContents.loadFile(path.join(this.opts.rendererDir, 'browser.html'));
    toolbar.webContents.once('did-finish-load', () => this.pushState());

    const wc = page.webContents;
    // Give the view a renderer right away, so recording is fully on before the first real page.
    void wc.loadURL('about:blank');
    this.watch(wc);
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      wc.on(ev as 'did-navigate', () => this.pushState());
    }
    wc.on('page-title-updated', (_e, title) => win.setTitle(title ? `${title} – Restless browser` : 'Restless browser'));
    wc.on('did-navigate', (_e, url) => {
      if (!this.named && /^https?:/.test(url)) this.rename(url);
    });

    // Popups (OAuth sign-in windows and the like) open as real windows and are recorded too.
    wc.setWindowOpenHandler(({ url }) => {
      if (!/^https?:/.test(url)) {
        if (/^mailto:/.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 900, height: 720, autoHideMenuBar: true, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } },
      };
    });
    wc.on('did-create-window', (child: BrowserWindow) => this.watch(child.webContents));

    win.on('closed', () => {
      void this.endSession('The browser closed before this finished.');
      this.win = null;
      this.toolbar = null;
      this.page = null;
    });
  }

  /** Shared by the page and its popups: no file:// navigation, a small context menu, shortcuts. */
  private harden(wc: WebContents) {
    wc.on('will-navigate', (e, url) => {
      if (!/^(https?|about|data|blob):/.test(url)) e.preventDefault();
    });
    wc.on('context-menu', (_e, p) => {
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (p.linkURL) items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
      if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
      else if (p.selectionText) items.push({ role: 'copy' });
      if (items.length) items.push({ type: 'separator' });
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
      );
      Menu.buildFromTemplate(items).popup();
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const mod = process.platform === 'darwin' ? input.meta : input.control;
      const key = input.key.toLowerCase();
      if (input.key === 'F5' || (mod && key === 'r')) wc.reload();
      else if (input.key === 'F12' || (mod && input.shift && key === 'i')) wc.openDevTools({ mode: 'detach' });
      else if (input.alt && input.key === 'ArrowLeft') wc.navigationHistory.goBack();
      else if (input.alt && input.key === 'ArrowRight') wc.navigationHistory.goForward();
      else if (mod && key === 'l' && wc === this.page?.webContents) this.toolbar?.webContents.send('browser:focus-address');
      else return;
      e.preventDefault();
    });
  }

  private pushState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      const wc = this.page?.webContents;
      if (!wc || !this.toolbar) return;
      const state: ToolbarState = {
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        loading: wc.isLoading(),
        paused: this.paused,
        count: (this.session?.entryCount ?? 0) + this.batch.length,
      };
      this.toolbar.webContents.send('browser:state', state);
    }, 30);
  }
}

/** Self-signed certificates are common for local dev servers; accept them for localhost only. */
export function allowLocalCertificates() {
  app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* not a URL */
    }
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      event.preventDefault();
      callback(true);
    } else callback(false);
  });
}
