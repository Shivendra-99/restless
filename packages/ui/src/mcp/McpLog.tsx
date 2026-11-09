import { useMemo, useState } from 'react';
import type { McpLogEntry } from '@probe/core';

const GLYPH: Record<McpLogEntry['direction'], string> = { out: '→', in: '←', error: '!', stderr: '≡', info: '·' };

function summary(e: McpLogEntry): string {
  if (e.direction === 'stderr' || e.direction === 'error' || e.direction === 'info') return String(e.message).split('\n')[0];
  const m = e.message as { method?: string; id?: unknown; error?: { message?: string }; result?: unknown; params?: unknown };
  if (m.method) return `${m.method}${m.id !== undefined ? `  #${m.id}` : '  (notification)'}`;
  if (m.error) return `error #${m.id}: ${m.error.message}`;
  return `result #${m.id}`;
}

/** JSON-RPC wire log: every frame in and out, plus server stderr. */
export function McpLog({ entries, onClear }: { entries: McpLogEntry[]; onClear: () => void }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [hideStderr, setHideStderr] = useState(false);
  const [q, setQ] = useState('');
  const t0 = entries[0]?.ts ?? 0;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !(hideStderr && e.direction === 'stderr'))
      .filter(({ e }) => !s || JSON.stringify(e.message).toLowerCase().includes(s));
  }, [entries, hideStderr, q]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="toolbar" style={{ padding: '8px 12px', margin: 0, borderBottom: '1px solid var(--line-soft)' }}>
        <input className="input" placeholder="Search messages" aria-label="Search messages" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <label style={{ fontSize: 13, color: 'var(--text-2)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={hideStderr} onChange={(e) => setHideStderr(e.target.checked)} /> Hide stderr
        </label>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {entries.length} messages (→ sent, ← received)
        </span>
        <button className="btn ghost small" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="log" role="log">
        {shown.length === 0 && <div className="empty">Messages between Probe and the server appear here.</div>}
        {shown.map(({ e, i }) => (
          <div
            key={i}
            className="log-row"
            onClick={() =>
              setOpen((prev) => {
                const n = new Set(prev);
                if (n.has(i)) n.delete(i);
                else n.add(i);
                return n;
              })
            }
          >
            <span className="ts">+{((e.ts - t0) / 1000).toFixed(3)}s</span>
            <span className={`dir-${e.direction}`} title={e.direction}>
              {GLYPH[e.direction]}
            </span>
            <span className={`log-summary dir-${e.direction === 'out' || e.direction === 'in' ? 'none' : e.direction}`}>{summary(e)}</span>
            {open.has(i) && <pre>{typeof e.message === 'string' ? e.message : JSON.stringify(e.message, null, 2)}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}
