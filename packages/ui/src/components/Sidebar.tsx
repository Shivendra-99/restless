import { useMemo, useState, type ReactNode } from 'react';
import type { HistoryEntry, RequestItem } from '@probe/core';
import { formatMs, statusClass } from '../util';

interface Props {
  requests: RequestItem[];
  history: HistoryEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenHistory: (h: HistoryEntry) => void;
  onClearHistory: () => void;
}

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  items: RequestItem[];
}

function buildTree(requests: RequestItem[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: new Map(), items: [] };
  for (const r of requests) {
    let node = root;
    for (const part of (r.folder || '').split('/').filter(Boolean)) {
      let next = node.folders.get(part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: new Map(), items: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.items.push(r);
  }
  return root;
}

export function Sidebar(p: Props) {
  const [view, setView] = useState<'requests' | 'history'>('requests');
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return p.requests;
    return p.requests.filter((r) => `${r.name} ${r.url} ${r.method} ${r.folder}`.toLowerCase().includes(s));
  }, [p.requests, q]);
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  const toggle = (path: string) =>
    setClosed((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const renderNode = (node: FolderNode, depth: number): ReactNode => (
    <>
      {[...node.folders.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => {
          const open = !closed.has(f.path) || q.trim() !== '';
          return (
            <div key={f.path}>
              <div className="folder" style={{ paddingLeft: 10 + depth * 12 }} onClick={() => toggle(f.path)} role="button" aria-expanded={open}>
                <span className={`caret ${open ? 'open' : ''}`}>›</span>
                {f.name}
              </div>
              {open && renderNode(f, depth + 1)}
            </div>
          );
        })}
      {node.items.map((r) => (
        <div
          key={r.id}
          className={`row ${p.activeId === r.id ? 'active' : ''}`}
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => p.onSelect(r.id)}
          onDoubleClick={() => setRenaming(r.id)}
        >
          <span className={`method m-${r.method}`}>{r.method}</span>
          {renaming === r.id ? (
            <input
              className="input"
              autoFocus
              defaultValue={r.name}
              aria-label="Rename request"
              onBlur={(e) => {
                p.onRename(r.id, e.target.value.trim() || r.name);
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <span className="name" title={r.url}>
              {r.name}
            </span>
          )}
          <span className="actions">
            <button className="icon-btn" title="Duplicate" aria-label={`Duplicate ${r.name}`} onClick={(e) => (e.stopPropagation(), p.onDuplicate(r.id))}>
              ⧉
            </button>
            <button className="icon-btn" title="Delete" aria-label={`Delete ${r.name}`} onClick={(e) => (e.stopPropagation(), p.onDelete(r.id))}>
              ✕
            </button>
          </span>
        </div>
      ))}
    </>
  );

  return (
    <aside className="sidebar">
      <div className="side-actions">
        <button className="btn" onClick={p.onNew}>
          New request
        </button>
        <button className="btn ghost" onClick={p.onImport}>
          Import
        </button>
      </div>
      <input className="input side-search" placeholder="Filter requests" aria-label="Filter requests" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="side-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'requests'} onClick={() => setView('requests')}>
          Requests
        </button>
        <button role="tab" aria-selected={view === 'history'} onClick={() => setView('history')}>
          History
        </button>
      </div>
      <div className="tree">
        {view === 'requests' &&
          (p.requests.length === 0 ? (
            <div className="empty" style={{ padding: 14, fontSize: 13 }}>
              No requests yet. Create one, or import a Postman collection or cURL command.
            </div>
          ) : (
            renderNode(tree, 0)
          ))}
        {view === 'history' && (
          <>
            {p.history.length === 0 && (
              <div className="empty" style={{ padding: 14, fontSize: 13 }}>
                Requests you send show up here.
              </div>
            )}
            {p.history.map((h) => (
              <div key={h.id} className="row hist-row" onClick={() => p.onOpenHistory(h)} title={new Date(h.at).toLocaleString()}>
                <span className={`method m-${h.method}`}>{h.method}</span>
                <span className="url">{h.url}</span>
                <span className={`mono ${statusClass(h.status)}`} style={{ fontSize: 11.5, textAlign: 'right' }} title={formatMs(h.durationMs)}>
                  {h.status || 'ERR'}
                </span>
              </div>
            ))}
            {p.history.length > 0 && (
              <div style={{ padding: 10 }}>
                <button className="btn ghost small" onClick={p.onClearHistory}>
                  Clear history
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
