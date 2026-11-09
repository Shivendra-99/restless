import { useMemo, useState, type ReactNode } from 'react';
import {
  addFolder,
  collectionFolders,
  countInFolder,
  deleteFolder,
  newCollection,
  newId,
  renameFolder,
  type Collection,
  type HistoryEntry,
  type RequestItem,
  type Workspace,
} from '@restless/core';
import { Menu } from './Menu';
import { formatMs, statusClass } from '../util';

interface Props {
  ws: Workspace;
  update: (fn: (w: Workspace) => Workspace) => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewRequest: (collectionId?: string, folder?: string) => void;
  onImport: () => void;
  onExport: (collectionId: string) => void;
  onOpenHistory: (h: HistoryEntry) => void;
}

type Editing = { kind: 'collection'; id: string } | { kind: 'folder'; id: string; path: string } | { kind: 'request'; id: string } | null;

const NEW_FOLDER = 'New folder';

function InlineName({ value, label, onDone }: { value: string; label: string; onDone: (v: string | null) => void }) {
  return (
    <input
      className="input inline-name"
      autoFocus
      defaultValue={value}
      aria-label={label}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.target.value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') onDone(null);
      }}
    />
  );
}

export function Sidebar({ ws, update, activeId, onSelect, onNewRequest, onImport, onExport, onOpenHistory }: Props) {
  const [view, setView] = useState<'collections' | 'history'>('collections');
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);

  const query = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!query) return null;
    return new Set(ws.requests.filter((r) => `${r.name} ${r.url} ${r.method} ${r.folder}`.toLowerCase().includes(query)).map((r) => r.id));
  }, [ws.requests, query]);

  const toggle = (key: string) =>
    setClosed((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const isOpen = (key: string) => !!query || !closed.has(key);
  const openKey = (key: string) => setClosed((prev) => (prev.has(key) ? new Set([...prev].filter((k) => k !== key)) : prev));

  const createCollection = () => {
    const c = newCollection('New collection', ws.collections);
    update((w) => ({ ...w, collections: [...w.collections, c] }));
    setEditing({ kind: 'collection', id: c.id });
    setView('collections');
  };

  const createFolder = (collectionId: string, parent: string) => {
    const existing = new Set(collectionFolders(ws.collections.find((c) => c.id === collectionId)!, ws.requests));
    let name = NEW_FOLDER;
    for (let i = 2; existing.has(parent ? `${parent}/${name}` : name); i++) name = `${NEW_FOLDER} ${i}`;
    update((w) => addFolder(w, collectionId, parent, name));
    openKey(collectionId);
    if (parent) openKey(`${collectionId}::${parent}`);
    setEditing({ kind: 'folder', id: collectionId, path: parent ? `${parent}/${name}` : name });
  };

  const requestRow = (r: RequestItem, depth: number) => (
    <div
      key={r.id}
      className={`row ${activeId === r.id ? 'active' : ''}`}
      style={{ paddingLeft: 12 + depth * 14 }}
      onClick={() => onSelect(r.id)}
      onDoubleClick={() => setEditing({ kind: 'request', id: r.id })}
      role="treeitem"
      aria-selected={activeId === r.id}
    >
      <span className={`method m-${r.method}`}>{r.method}</span>
      {editing?.kind === 'request' && editing.id === r.id ? (
        <InlineName
          value={r.name}
          label="Request name"
          onDone={(name) => {
            if (name) update((w) => ({ ...w, requests: w.requests.map((x) => (x.id === r.id ? { ...x, name } : x)) }));
            setEditing(null);
          }}
        />
      ) : (
        <span className="name" title={r.url}>
          {r.name}
        </span>
      )}
      <span className="actions">
        <Menu
          label={`Options for ${r.name}`}
          items={[
            { label: 'Rename', onSelect: () => setEditing({ kind: 'request', id: r.id }) },
            {
              label: 'Duplicate',
              onSelect: () => {
                const copy = { ...structuredClone(r), id: newId(), name: `${r.name} copy` };
                update((w) => ({ ...w, requests: [...w.requests, copy] }));
                onSelect(copy.id);
              },
            },
            {
              label: 'Delete',
              danger: true,
              onSelect: () => {
                if (window.confirm(`Delete the request "${r.name}"?`)) update((w) => ({ ...w, requests: w.requests.filter((x) => x.id !== r.id) }));
              },
            },
          ]}
        />
      </span>
    </div>
  );

  const renderLevel = (c: Collection, folders: string[], parent: string, depth: number): ReactNode => {
    const children = folders.filter((f) => (parent ? f.startsWith(`${parent}/`) && !f.slice(parent.length + 1).includes('/') : !f.includes('/')));
    const requests = ws.requests.filter((r) => r.collectionId === c.id && r.folder === parent && (!matches || matches.has(r.id)));
    return (
      <>
        {children.map((path) => {
          const key = `${c.id}::${path}`;
          const name = path.slice(path.lastIndexOf('/') + 1);
          const hasMatch = !matches || ws.requests.some((r) => r.collectionId === c.id && (r.folder === path || r.folder.startsWith(`${path}/`)) && matches.has(r.id));
          if (!hasMatch) return null;
          const open = isOpen(key);
          return (
            <div key={key} role="group">
              <div className="folder-row" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => toggle(key)} role="treeitem" aria-expanded={open}>
                <span className={`caret ${open ? 'open' : ''}`}>›</span>
                <FolderIcon />
                {editing?.kind === 'folder' && editing.id === c.id && editing.path === path ? (
                  <InlineName
                    value={name}
                    label="Folder name"
                    onDone={(v) => {
                      if (v && v !== name) update((w) => renameFolder(w, c.id, path, v));
                      setEditing(null);
                    }}
                  />
                ) : (
                  <span className="name">{name}</span>
                )}
                <span className="actions">
                  <button className="icon-btn" title="Add request here" aria-label={`Add request to ${name}`} onClick={(e) => (e.stopPropagation(), openKey(key), onNewRequest(c.id, path))}>
                    +
                  </button>
                  <Menu
                    label={`Options for folder ${name}`}
                    items={[
                      { label: 'Add request', onSelect: () => (openKey(key), onNewRequest(c.id, path)) },
                      { label: 'Add folder', onSelect: () => createFolder(c.id, path) },
                      { label: 'Rename', onSelect: () => setEditing({ kind: 'folder', id: c.id, path }) },
                      {
                        label: 'Delete',
                        danger: true,
                        onSelect: () => {
                          const n = countInFolder(ws, c.id, path);
                          if (window.confirm(n ? `Delete the folder "${name}" and the ${n} request${n === 1 ? '' : 's'} in it?` : `Delete the folder "${name}"?`)) update((w) => deleteFolder(w, c.id, path));
                        },
                      },
                    ]}
                  />
                </span>
              </div>
              {open && renderLevel(c, folders, path, depth + 1)}
            </div>
          );
        })}
        {requests.map((r) => requestRow(r, depth))}
      </>
    );
  };

  const visibleCollections = ws.collections.filter(
    (c) => !matches || c.name.toLowerCase().includes(query) || ws.requests.some((r) => r.collectionId === c.id && matches.has(r.id)),
  );

  return (
    <aside className="sidebar">
      <div className="side-actions">
        <button className="btn" onClick={() => onNewRequest()}>
          New request
        </button>
        <button className="btn ghost" onClick={onImport}>
          Import
        </button>
      </div>
      <div className="side-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'collections'} onClick={() => setView('collections')}>
          Collections
        </button>
        <button role="tab" aria-selected={view === 'history'} onClick={() => setView('history')}>
          History
        </button>
      </div>

      {view === 'collections' ? (
        <>
          <div className="side-tools">
            <input className="input" placeholder="Filter" aria-label="Filter requests" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn small" onClick={createCollection} title="Create a new collection">
              + Collection
            </button>
          </div>
          <div className="tree" role="tree" aria-label="Collections">
            {ws.collections.length === 0 && (
              <div className="side-empty">
                <p>Collections group your requests, like folders in Postman.</p>
                <button className="btn primary small" onClick={createCollection}>
                  Create a collection
                </button>
              </div>
            )}
            {query && visibleCollections.length === 0 && <div className="side-empty">Nothing matches “{q}”.</div>}
            {visibleCollections.map((c) => {
              const open = isOpen(c.id);
              const count = ws.requests.filter((r) => r.collectionId === c.id).length;
              const folders = collectionFolders(c, ws.requests);
              return (
                <div key={c.id} className="coll" role="group">
                  <div className="coll-row" onClick={() => toggle(c.id)} role="treeitem" aria-expanded={open}>
                    <span className={`caret ${open ? 'open' : ''}`}>›</span>
                    {editing?.kind === 'collection' && editing.id === c.id ? (
                      <InlineName
                        value={c.name}
                        label="Collection name"
                        onDone={(name) => {
                          if (name) update((w) => ({ ...w, collections: w.collections.map((x) => (x.id === c.id ? { ...x, name } : x)) }));
                          setEditing(null);
                        }}
                      />
                    ) : (
                      <span className="name" onDoubleClick={(e) => (e.stopPropagation(), setEditing({ kind: 'collection', id: c.id }))}>
                        {c.name}
                      </span>
                    )}
                    <span className="count">{count}</span>
                    <span className="actions">
                      <button className="icon-btn" title="Add request" aria-label={`Add request to ${c.name}`} onClick={(e) => (e.stopPropagation(), openKey(c.id), onNewRequest(c.id, ''))}>
                        +
                      </button>
                      <Menu
                        label={`Options for collection ${c.name}`}
                        items={[
                          { label: 'Add request', onSelect: () => (openKey(c.id), onNewRequest(c.id, '')) },
                          { label: 'Add folder', onSelect: () => createFolder(c.id, '') },
                          { label: 'Rename', onSelect: () => setEditing({ kind: 'collection', id: c.id }) },
                          { label: 'Export (Postman format)', onSelect: () => onExport(c.id) },
                          {
                            label: 'Delete',
                            danger: true,
                            onSelect: () => {
                              if (!window.confirm(count ? `Delete the collection "${c.name}" and its ${count} request${count === 1 ? '' : 's'}?` : `Delete the collection "${c.name}"?`)) return;
                              update((w) => ({ ...w, collections: w.collections.filter((x) => x.id !== c.id), requests: w.requests.filter((r) => r.collectionId !== c.id) }));
                            },
                          },
                        ]}
                      />
                    </span>
                  </div>
                  {open && (
                    <>
                      {renderLevel(c, folders, '', 1)}
                      {count === 0 && folders.length === 0 && !query && (
                        <button className="add-first" onClick={() => onNewRequest(c.id, '')}>
                          + Add a request
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="tree">
          {ws.history.length === 0 && <div className="side-empty">Requests you send show up here.</div>}
          {ws.history.map((h) => (
            <div key={h.id} className="row hist-row" onClick={() => onOpenHistory(h)} title={new Date(h.at).toLocaleString()}>
              <span className={`method m-${h.method}`}>{h.method}</span>
              <span className="url">{h.url}</span>
              <span className={`mono ${statusClass(h.status)}`} style={{ fontSize: 11.5, textAlign: 'right' }} title={formatMs(h.durationMs)}>
                {h.status || 'ERR'}
              </span>
            </div>
          ))}
          {ws.history.length > 0 && (
            <div style={{ padding: 10 }}>
              <button className="btn ghost small" onClick={() => update((w) => ({ ...w, history: [] }))}>
                Clear history
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="folder-icon">
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
