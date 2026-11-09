import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collectionFolders,
  DEFAULT_COLLECTION_NAME,
  exportPostmanCollection,
  newCollection,
  newId,
  newRequest,
  resolveRequest,
  resolveVariables,
  runCaptures,
  setGlobal,
  variableMap,
  type Bridge,
  type Capture,
  type HistoryEntry,
  type HttpResponse,
  type RequestItem,
  type ResolvedRequest,
  type Workspace,
} from '@restless/core';
import { useWorkspace } from './state';
import { Sidebar } from './components/Sidebar';
import { RequestEditor, type Location } from './components/RequestEditor';
import { ResponseView } from './components/ResponseView';
import { VariablesDialog, type VariablesTarget } from './components/VariablesDialog';
import { ImportDialog } from './components/ImportDialog';
import { McpView } from './mcp/McpView';
import { errorText } from './util';

type Mode = 'http' | 'mcp';
interface Exchange {
  response: HttpResponse | null;
  sent: ResolvedRequest | null;
}
interface Toast {
  text: string;
  action?: { label: string; run: () => void };
  tone?: 'warn';
}

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="0.5" y="0.5" width="17" height="17" rx="4" fill="none" stroke="var(--line)" />
      <polyline points="2,11 5,11 7,5 10,14 12,8 13.5,11 16,11" fill="none" stroke="var(--signal)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Make sure there is a collection to put a new request in; returns the workspace and the collection id. */
function withCollection(w: Workspace, preferred?: string): [Workspace, string] {
  if (preferred && w.collections.some((c) => c.id === preferred)) return [w, preferred];
  if (w.collections[0]) return [w, w.collections[0].id];
  const c = newCollection(DEFAULT_COLLECTION_NAME, []);
  return [{ ...w, collections: [c] }, c.id];
}

export function App({ bridge }: { bridge: Bridge }) {
  const { ws, update, saveState, loadError, location, reload } = useWorkspace(bridge);
  const [mode, setMode] = useState<Mode>('http');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [exchanges, setExchanges] = useState<Record<string, Exchange>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [varsOpen, setVarsOpen] = useState<VariablesTarget | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flash = useCallback((t: Toast | string) => {
    setToast(typeof t === 'string' ? { text: t } : t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }, []);

  useEffect(() => {
    if (ws && !activeId && ws.requests[0]) setActiveId(ws.requests[0].id);
  }, [ws, activeId]);

  const active = ws?.requests.find((r) => r.id === activeId) ?? null;
  const vars = useMemo(() => (ws ? resolveVariables(ws) : new Map()), [ws]);
  const globalNames = useMemo(() => new Set((ws?.globals ?? []).map((g) => g.key)), [ws?.globals]);
  const locations = useMemo<Location[]>(
    () =>
      (ws?.collections ?? []).flatMap((c) => [
        { collectionId: c.id, folder: '', label: c.name },
        ...collectionFolders(c, ws!.requests).map((f) => ({ collectionId: c.id, folder: f, label: `${c.name} / ${f.split('/').join(' / ')}` })),
      ]),
    [ws],
  );

  const patchRequest = (item: RequestItem) => update((w) => ({ ...w, requests: w.requests.map((r) => (r.id === item.id ? { ...item, updatedAt: Date.now() } : r)) }));

  /** New request in the given place; by default next to the request that is open. */
  const addRequest = (collectionId?: string, folder?: string, partial: Partial<RequestItem> = {}) => {
    const id = newId();
    const place = collectionId ?? active?.collectionId;
    const inFolder = folder ?? (collectionId ? '' : (active?.folder ?? ''));
    update((w) => {
      const [w2, cid] = withCollection(w, place);
      return { ...w2, requests: [...w2.requests, newRequest({ ...partial, id, collectionId: cid, folder: cid === place ? inFolder : '' })] };
    });
    setActiveId(id);
    setMode('http');
  };

  const send = useCallback(async () => {
    if (!ws || !active || sendingId) return;
    const { request } = resolveRequest(active, variableMap(ws));
    setSendingId(active.id);
    const item = active;
    try {
      const response = await bridge.sendHttp(request);
      setExchanges((p) => ({ ...p, [item.id]: { response, sent: request } }));
      const h: HistoryEntry = { id: newId(), at: Date.now(), method: request.method, url: request.url, status: response.status, durationMs: response.timings.total, requestId: item.id };
      const preview = runCaptures(item, response, ws.globals);
      update((w) => ({ ...w, history: [h, ...w.history].slice(0, 200), globals: runCaptures(item, response, w.globals).globals }));
      if (preview.updated.length) {
        flash({ text: `Updated ${preview.updated.map((u) => `{{${u.variable}}}`).join(', ')} from the response`, action: { label: 'View', run: () => setVarsOpen({ scope: 'global', focus: preview.updated[0].variable }) } });
      } else if (preview.missed.length && response.status >= 200 && response.status < 300) {
        flash({ tone: 'warn', text: `Could not update ${preview.missed.map((m) => `{{${m.variable}}}`).join(', ')}: ${preview.missed[0].reason}` });
      }
    } catch (e) {
      setExchanges((p) => ({ ...p, [item.id]: { sent: request, response: { status: 0, statusText: '', headers: [], body: '', size: 0, timings: { total: 0 }, url: request.url, error: errorText(e) } } }));
    } finally {
      setSendingId(null);
    }
  }, [ws, active, sendingId, bridge, update, flash]);

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

  const exportCollection = async (collectionId: string) => {
    const c = ws?.collections.find((x) => x.id === collectionId);
    if (!ws || !c) return;
    const text = JSON.stringify(exportPostmanCollection(c, ws.requests), null, 2);
    const name = `${c.name.replace(/[^\w.-]+/g, '_')}.postman_collection.json`;
    try {
      if (bridge.saveFile) {
        const where = await bridge.saveFile(name, text);
        if (where) flash(`Exported ${c.name} to ${where}`);
      } else {
        downloadText(name, text);
        flash(`Exported ${c.name} as ${name}`);
      }
    } catch (e) {
      flash({ tone: 'warn', text: `Could not export: ${errorText(e)}` });
    }
  };

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
              title="Environment in use"
              value={ws.activeEnvironmentId ?? ''}
              onChange={(e) => update((w) => ({ ...w, activeEnvironmentId: e.target.value || null }))}
            >
              <option value="">No environment</option>
              {ws.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <button className="btn small" onClick={() => setVarsOpen({ scope: 'global' })}>
              Variables{ws.globals.length ? <span className="count">{ws.globals.length}</span> : null}
            </button>
          </>
        )}
      </header>

      <div className="body" style={mode === 'mcp' ? { gridTemplateColumns: '1fr' } : undefined}>
        {mode === 'http' && (
          <Sidebar
            ws={ws}
            update={update}
            activeId={activeId}
            onSelect={setActiveId}
            onNewRequest={(cid, folder) => addRequest(cid, folder)}
            onImport={() => setImportOpen(true)}
            onExport={(cid) => void exportCollection(cid)}
            onOpenHistory={(h) => {
              if (h.requestId && ws.requests.some((r) => r.id === h.requestId)) setActiveId(h.requestId);
              else addRequest(undefined, undefined, { method: h.method, url: h.url, name: `${h.method} ${h.url}` });
            }}
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
                vars={vars}
                onOpenVariable={(name) => {
                  const v = vars.get(name);
                  if (v?.scope === 'environment' && ws.activeEnvironmentId) {
                    setVarsOpen({ scope: 'environment', id: ws.activeEnvironmentId, focus: name });
                    return;
                  }
                  // Not set yet: add an empty global row for it so the dialog opens ready to type the value.
                  if (!v) update((w) => (w.globals.some((g) => g.key === name) ? w : { ...w, globals: [...w.globals, { key: name, value: '', enabled: true }] }));
                  setVarsOpen({ scope: 'global', focus: name });
                }}
                locations={locations}
                onNotice={flash}
              />
              <ResponseView
                key={`r-${active.id}`}
                response={exchange?.response ?? null}
                sent={exchange?.sent ?? null}
                sending={sendingId === active.id}
                globalNames={globalNames}
                onSaveVariable={(pick, name, keep) => {
                  const cap: Capture = { id: newId(), variable: name, from: pick.from, path: pick.path };
                  update((w) => ({
                    ...w,
                    globals: setGlobal(w.globals, name, pick.value),
                    requests: keep
                      ? w.requests.map((r) => (r.id === active.id ? { ...r, captures: [...(r.captures ?? []).filter((c) => c.variable !== name), cap] } : r))
                      : w.requests,
                  }));
                  flash({
                    text: `Saved {{${name}}}. Use it in any request${keep ? '; it updates each time this request is sent' : ''}.`,
                    action: { label: 'View', run: () => setVarsOpen({ scope: 'global', focus: name }) },
                  });
                }}
              />
            </div>
          ) : (
            <div className="empty">
              <h2>Start with a request</h2>
              <p>Requests live in collections. Everything is stored on this machine: no account, no sync, nothing leaves unless you send it.</p>
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

      {toast && (
        <div className={`toast ${toast.tone ?? ''}`} role="status">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="btn ghost small"
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      {varsOpen && <VariablesDialog ws={ws} update={update} initial={varsOpen} onOpenRequest={setActiveId} onClose={() => setVarsOpen(null)} />}
      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImport={(res) => {
            const firstId = res.requests[0]?.id;
            update((w) => {
              let next = { ...w, environments: [...w.environments, ...res.environments], activeEnvironmentId: w.activeEnvironmentId ?? res.environments[0]?.id ?? null };
              for (const g of res.globals) next = { ...next, globals: setGlobal(next.globals, g.key, g.value).map((x) => (x.key === g.key ? { ...x, enabled: g.enabled, secret: g.secret || x.secret } : x)) };
              if (res.collection) return { ...next, collections: [...next.collections, res.collection], requests: [...next.requests, ...res.requests] };
              const [w2, cid] = withCollection(next, active?.collectionId);
              return { ...w2, requests: [...w2.requests, ...res.requests.map((r) => ({ ...r, collectionId: cid, folder: cid === active?.collectionId ? active.folder : '' }))] };
            });
            if (firstId) setActiveId(firstId);
            setMode('http');
            flash(res.summary);
          }}
        />
      )}
    </div>
  );
}
