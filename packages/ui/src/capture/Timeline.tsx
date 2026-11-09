import { useCallback, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { CapturedEntry } from '@restless/core';

interface Props {
  entries: CapturedEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Page loads, drawn as markers so you can see which page each call belongs to. */
  pages?: CapturedEntry[];
  live: boolean;
  follow: boolean;
  onFollow: (on: boolean) => void;
}

export const statusTone = (e: CapturedEntry) => (e.error || !e.status ? 'err' : e.status >= 500 ? 'err' : e.status >= 400 ? 'warn' : e.status >= 300 ? 'info' : 'ok');

const pagePath = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.host : u.pathname;
  } catch {
    return url;
  }
};

export const clock = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

/**
 * The time-travel bar: every request is a tick at the moment it started. Drag or click to go back to
 * any moment, step one request at a time, or jump to the latest and follow new ones live.
 */
export function Timeline({ entries, selectedId, onSelect, pages = [], live, follow, onFollow }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const idx = entries.findIndex((e) => e.id === selectedId);
  const t0 = entries[0]?.startedAt ?? 0;
  const t1 = useMemo(() => Math.max(t0 + 1000, ...entries.map((e) => e.startedAt + (e.durationMs ?? 0))), [entries, t0]);
  const span = t1 - t0;
  const pos = (t: number) => `${(((t - t0) / span) * 100).toFixed(3)}%`;

  const go = useCallback(
    (i: number) => {
      if (!entries.length) return;
      const n = Math.max(0, Math.min(entries.length - 1, i));
      onSelect(entries[n].id);
      onFollow(live && n === entries.length - 1);
    },
    [entries, onSelect, onFollow, live],
  );

  const pickAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !entries.length) return;
    const t = t0 + ((clientX - r.left) / r.width) * span;
    let best = 0;
    for (let i = 1; i < entries.length; i++) if (Math.abs(entries[i].startedAt - t) < Math.abs(entries[best].startedAt - t)) best = i;
    go(best);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pickAt(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons === 1) pickAt(e.clientX);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const keys: Record<string, number> = { ArrowLeft: idx - 1, ArrowRight: idx + 1, Home: 0, End: entries.length - 1 };
    if (e.key in keys) {
      e.preventDefault();
      go(keys[e.key]);
    }
  };

  const sel = idx >= 0 ? entries[idx] : null;
  // Page loads inside the range, plus the page the first request belongs to (pinned to the left edge).
  const loads = pages.filter((p) => p.method === 'GET' && p.startedAt <= t1);
  const lead = [...loads].reverse().find((p) => p.startedAt < t0);
  const marks = [...(lead ? [{ ...lead, startedAt: t0 }] : []), ...loads.filter((p) => p.startedAt >= t0)];

  return (
    <div className="timeline">
      <div className="tl-controls">
        <button className="icon-btn tl-btn" onClick={() => go(0)} disabled={idx <= 0} aria-label="First request" title="First request (Home)">
          ⏮
        </button>
        <button className="icon-btn tl-btn" onClick={() => go(idx - 1)} disabled={idx <= 0} aria-label="Previous request" title="Previous request (←)">
          ◀
        </button>
        <button className="icon-btn tl-btn" onClick={() => go(idx + 1)} disabled={idx < 0 || idx >= entries.length - 1} aria-label="Next request" title="Next request (→)">
          ▶
        </button>
        <button className="icon-btn tl-btn" onClick={() => go(entries.length - 1)} disabled={idx === entries.length - 1} aria-label="Latest request" title="Latest request (End)">
          ⏭
        </button>
        <span className="tl-readout" aria-live="polite">
          {sel ? (
            <>
              <b>
                {idx + 1} of {entries.length}
              </b>{' '}
              at {clock(sel.startedAt)} <span className="tl-rel">+{((sel.startedAt - t0) / 1000).toFixed(2)} s</span>
            </>
          ) : (
            `${entries.length} requests`
          )}
        </span>
        <span style={{ flex: 1 }} />
        {live && (
          <button className={`btn small ${follow ? 'live-on' : ''}`} aria-pressed={follow} onClick={() => (follow ? onFollow(false) : go(entries.length - 1))} title="Keep showing the newest request as it arrives">
            <span className="live-dot" /> {follow ? 'Following live' : 'Jump to live'}
          </button>
        )}
      </div>
      <div
        ref={track}
        className="tl-track"
        role="slider"
        tabIndex={0}
        aria-label="Time travel through captured requests"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, entries.length)}
        aria-valuenow={idx + 1}
        aria-valuetext={sel ? `${sel.method} ${sel.url} at ${clock(sel.startedAt)}` : 'none'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKey}
      >
        {entries.map((e) => (
          <span
            key={e.id}
            className={`tl-tick ${statusTone(e)} ${e.id === selectedId ? 'sel' : ''}`}
            style={{ left: pos(e.startedAt), width: `max(3px, ${(((e.durationMs ?? 0) / span) * 100).toFixed(3)}%)` }}
          />
        ))}
        {sel && <div className="tl-head" style={{ left: pos(sel.startedAt) }} />}
        {marks.map((p) => (
          <div key={p.id} className="tl-marker" style={{ left: pos(p.startedAt) }} title={`Page loaded: ${p.url}`}>
            <span>{pagePath(p.url)}</span>
          </div>
        ))}
      </div>
      <div className="tl-scale">
        <span>{entries.length ? clock(t0) : ''}</span>
        <span>{entries.length ? `${(span / 1000).toFixed(1)} s` : ''}</span>
        <span>{entries.length ? clock(t1) : ''}</span>
      </div>
    </div>
  );
}
