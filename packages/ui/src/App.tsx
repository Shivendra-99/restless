import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { envToVars, newId, newRequest, resolveRequest, type Bridge, type HistoryEntry, type HttpResponse, type RequestItem, type ResolvedRequest, type Workspace } from '@restless/core';
import { useWorkspace } from './state';
import { Sidebar } from './components/Sidebar';
import { RequestEditor } from './components/RequestEditor';
import { ResponseView } from './components/ResponseView';
import { EnvEditor } from './components/EnvEditor';
import { ImportDialog } from './components/ImportDialog';
import { McpView } from './mcp/McpView';
import { errorText } from './util';

type Mode = 'http' | 'mcp';
interface Exchange {
  response: HttpResponse | null;
  sent: ResolvedRequest | null;
}

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="0.5" y="0.5" width="17" height="17" rx="4" fill="none" stroke="var(--line)" />
      <polyline points="2,11 5,11 7,5 10,14 12,8 13.5,11 16,11" fill="none" stroke="var(--signal)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function App({ bridge }: { bridge: Bridge }) {
  const { ws, update, saveState, loadError, location, reload } = useWorkspace(bridge);
  const [mode, setMode] = useState<Mode>('http');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [exchanges, setExchanges] = useState<Record<string, Exchange>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flash = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);

  useEffect(() => {
    if (ws && !activeId && ws.requests[0]) setActiveId(ws.requests[0].id);
  }, [ws, activeId]);

  const active = ws?.requests.find((r) => r.id === activeId) ?? null;
  const env = ws?.environments.find((e) => e.id === ws.activeEnvironmentId) ?? null;
  const unresolved = useMemo(() => (active ? resolveRequest(active, envToVars(env)).missing : []), [active, env]);

  const patchRequest = (item: RequestItem) => update((w) => ({ ...w, requests: w.requests.map((r) => (r.id === item.id ? { ...item, updatedAt: Date.now() } : r)) }));

  const addRequest = (partial: Partial<RequestItem> = {}) => {
    const r = newRequest(partial);
    update((w) => ({ ...w, requests: [...w.requests, r] }));
    setActiveId(r.id);
    setMode('http');
    return r;
  };

  const send = useCallback(async () => {
    if (!ws || !active || sendingId) return;
    const { request } = resolveRequest(active, envToVars(env));
    setSendingId(active.id);
    const id = active.id;
    try {
      const response = await bridge.sendHttp(request);
      setExchanges((p) => ({ ...p, [id]: { response, sent: request } }));
      const h: HistoryEntry = { id: newId(), at: Date.now(), method: request.method, url: request.url, status: response.status, durationMs: response.timings.total, requestId: id };
      update((w) => ({ ...w, history: [h, ...w.history].slice(0, 200) }));
    } catch (e) {
      setExchanges((p) => ({ ...p, [id]: { sent: request, response: { status: 0, statusText: '', headers: [], body: '', size: 0, timings: { total: 0 }, url: request.url, error: errorText(e) } } }));
    } finally {
      setSendingId(null);
    }
  }, [ws, active, env, sendingId, bridge, update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === 'http' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void send();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, send]);

  if (loadError) {
    return (
      <div className="empty">
        <h2>The workspace could not be opened</h2>
        <p>{loadError}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={() => void reload()}>
            Try again
          </button>
          {bridge.storage.chooseFolder && (
            <button className="btn" onClick={async () => (await bridge.storage.chooseFolder!()) && void reload()}>
              Choose another folder
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!ws) return <div className="empty">Opening workspace…</div>;

  const exchange = active ? exchanges[active.id] : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          Restless
        </div>
        <div className="mode-switch" role="group" aria-label="Mode">
          <button aria-pressed={mode === 'http'} onClick={() => setMode('http')}>
            API
          </button>
          <button aria-pressed={mode === 'mcp'} onClick={() => setMode('mcp')}>
            MCP
          </button>
        </div>
        <span className="spacer" />
        <span className="where" title={location}>
          {location}
        </span>
        {bridge.storage.chooseFolder && (
          <button className="btn ghost small" onClick={async () => (await bridge.storage.chooseFolder!()) && void reload()}>
            Open folder
          </button>
        )}
        <span className="save-state" aria-live="polite">
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''}
        </span>
        {mode === 'http' && (
          <>
            <select
              className="select"
              aria-label="Active environment"
              value={ws.activeEnvironmentId ?? ''}
              onChange={(e) => update((w: Workspace) => ({ ...w, activeEnvironmentId: e.target.value || null }))}
            >
              <option value="">No environment</option>
              {ws.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <button className="btn ghost small" onClick={() => setEnvOpen(true)}>
              Environments
            </button>
          </>
        )}
      </header>

      <div className="body" style={mode === 'mcp' ? { gridTemplateColumns: '1fr' } : undefined}>
        {mode === 'http' && (
          <Sidebar
            requests={ws.requests}
            history={ws.history}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={() => addRequest()}
            onImport={() => setImportOpen(true)}
            onRename={(id, name) => update((w) => ({ ...w, requests: w.requests.map((r) => (r.id === id ? { ...r, name } : r)) }))}
            onDuplicate={(id) => {
              const src = ws.requests.find((r) => r.id === id);
              if (src) addRequest({ ...structuredClone(src), id: newId(), name: `${src.name} copy` });
            }}
            onDelete={(id) => {
              const r = ws.requests.find((x) => x.id === id);
              if (!r || !window.confirm(`Delete "${r.name}"? This removes its file from the workspace folder.`)) return;
              update((w) => ({ ...w, requests: w.requests.filter((x) => x.id !== id) }));
              if (activeId === id) setActiveId(null);
            }}
            onOpenHistory={(h) => {
              if (h.requestId && ws.requests.some((r) => r.id === h.requestId)) setActiveId(h.requestId);
              else addRequest({ method: h.method, url: h.url, name: `${h.method} ${h.url}` });
            }}
            onClearHistory={() => update((w) => ({ ...w, history: [] }))}
          />
        )}
        <main className="main">
          {mode === 'mcp' ? (
            <McpView bridge={bridge} servers={ws.mcpServers} onServersChange={(mcpServers) => update((w) => ({ ...w, mcpServers }))} />
          ) : active ? (
            <div className="split">
              <RequestEditor
                key={active.id}
                item={active}
                onChange={patchRequest}
                onSend={() => void send()}
                sending={sendingId === active.id}
                onCancel={bridge.cancelHttp}
                unresolved={unresolved}
                onNotice={flash}
              />
              <ResponseView key={`r-${active.id}`} response={exchange?.response ?? null} sent={exchange?.sent ?? null} sending={sendingId === active.id} />
            </div>
          ) : (
            <div className="empty">
              <h2>Start with a request</h2>
              <p>Everything you create is stored as plain files on this machine. No account, no sync, nothing leaves unless you send it.</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={() => addRequest()}>
                  New request
                </button>
                <button className="btn" onClick={() => setImportOpen(true)}>
                  Import from Postman or cURL
                </button>
              </div>
            </div>
          )}
        </main>
      </div>

      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
      {envOpen && (
        <EnvEditor
          environments={ws.environments}
          activeId={ws.activeEnvironmentId}
          onChange={(environments) =>
            update((w) => ({
              ...w,
              environments,
              activeEnvironmentId: environments.some((e) => e.id === w.activeEnvironmentId) ? w.activeEnvironmentId : (environments[0]?.id ?? null),
            }))
          }
          onClose={() => setEnvOpen(false)}
        />
      )}
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImport={(requests, environments, summary) => {
            update((w) => ({
              ...w,
              requests: [...w.requests, ...requests],
              environments: [...w.environments, ...environments],
              activeEnvironmentId: w.activeEnvironmentId ?? environments[0]?.id ?? null,
            }));
            if (requests[0]) setActiveId(requests[0].id);
            setImportOpen(false);
            setMode('http');
            flash(summary);
          }}
        />
      )}
    </div>
  );
}
