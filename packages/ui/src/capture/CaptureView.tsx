import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildHar, isApiType, parseHar, type Bridge, type CaptureBridge, type CaptureBrowserStatus, type CapturedEntry, type CaptureSession, type Collection } from '@restless/core';
import { Menu } from '../components/Menu';
import { errorText, formatMs, statusClass } from '../util';
import { EntryDetail } from './EntryDetail';
import { Timeline } from './Timeline';

interface Props {
  bridge: Bridge;
  capture: CaptureBridge;
  collections: Collection[];
  /** Show this capture (the browser's "Show in Restless"). `at` makes the same id count again. */
  focus?: { id: string; at: number } | null;
  onSaveAsRequest: (entry: CapturedEntry, collectionId: string | null) => void;
  onNotice: (text: string) => void;
}

const ADDRESS_KEY = 'restless.capture.address';

function sessionLabel(s: CaptureSession) {
  const d = new Date(s.startedAt);
  const when = `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  return `${s.live ? '● ' : ''}${s.name} · ${when} · ${s.entryCount}`;
}

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return { host: u.host, path: `${u.pathname}${u.search}` };
  } catch {
    return { host: '', path: url };
  }
}

const readAddress = () => {
  try {
    return localStorage.getItem(ADDRESS_KEY) ?? '';
  } catch {
    return '';
  }
};

export function CaptureView({ bridge, capture, collections, focus, onSaveAsRequest, onNotice }: Props) {
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(focus?.id ?? null);
  const [entries, setEntries] = useState<CapturedEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState('');
  const [apiOnly, setApiOnly] = useState(true);
  const [browser, setBrowser] = useState<CaptureBrowserStatus | null>(null);
  const [address, setAddress] = useState(readAddress);
  const fileInput = useRef<HTMLInputElement>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    if (focus) {
      setSessionId(focus.id);
      setFollow(true);
    }
  }, [focus]);

  const session = sessions.find((s) => s.id === sessionId) ?? null;

  const refreshMeta = useCallback(async () => {
    const list = await capture.listSessions();
    setSessions(list);
    if (capture.browser) setBrowser(await capture.browser.status());
    if (!sessionRef.current && list[0]) setSessionId(list[0].id);
    if (sessionRef.current && !list.some((s) => s.id === sessionRef.current)) setSessionId(list[0]?.id ?? null);
  }, [capture]);

  const loadEntries = useCallback(async (id: string | null) => {
    setEntries(id ? await capture.getEntries(id) : []);
  }, [capture]);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);
  useEffect(() => {
    void loadEntries(sessionId);
    setSelectedId(null);
    setFollow(true);
  }, [sessionId, loadEntries]);

  // Live updates while recording: batch bursts of requests into one reload.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = capture.onChange((changed) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshMeta();
        if (!changed || changed === sessionRef.current) void loadEntries(sessionRef.current);
      }, 150);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [capture, refreshMeta, loadEntries]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return entries.filter((e) => (!apiOnly || isApiType(e.type)) && (!s || `${e.method} ${e.url} ${e.status ?? ''}`.toLowerCase().includes(s)));
  }, [entries, apiOnly, q]);
  const pages = useMemo(() => entries.filter((e) => e.type === 'document'), [entries]);

  // Follow live: keep the newest request selected as it arrives. Otherwise default to the first one.
  useEffect(() => {
    if (!shown.length) return;
    if (follow && session?.live) setSelectedId(shown[shown.length - 1].id);
    else if (!selectedId || !shown.some((e) => e.id === selectedId)) setSelectedId(shown[0].id);
  }, [shown, follow, session?.live, selectedId]);

  const selected = shown.find((e) => e.id === selectedId) ?? null;
  const selIndex = selected ? shown.indexOf(selected) : -1;

  // ← → step through time anywhere in this view (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.getAttribute('role') === 'slider' || t.closest('.dialog')) return;
      const next = e.key === 'ArrowLeft' ? selIndex - 1 : e.key === 'ArrowRight' ? selIndex + 1 : null;
      if (next === null || next < 0 || next >= shown.length) return;
      e.preventDefault();
      setSelectedId(shown[next].id);
      setFollow(!!session?.live && next === shown.length - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selIndex, shown, session?.live]);

  // Keep the selected row in view while scrubbing.
  useEffect(() => {
    document.querySelector('.cap-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const openBrowser = async (url?: string) => {
    if (!capture.browser) return;
    const target = (url ?? address).trim();
    try {
      if (target) localStorage.setItem(ADDRESS_KEY, target);
    } catch {
      /* not kept */
    }
    try {
      const id = await capture.browser.open(target || undefined);
      setSessionId(id);
      setFollow(true);
      await refreshMeta();
    } catch (e) {
      onNotice(errorText(e));
    }
  };

  const newCapture = async () => {
    const id = await capture.browser!.newCapture();
    setSessionId(id);
    setFollow(true);
    await refreshMeta();
  };

  const importHar = async (file: File) => {
    try {
      const { session: s, entries: list } = parseHar(await file.text(), file.name.replace(/\.har$/i, ''));
      await capture.importSession(s, list);
      setSessionId(s.id);
      await refreshMeta();
      onNotice(`Imported ${list.length} requests from ${file.name}`);
    } catch (e) {
      onNotice(errorText(e));
    }
  };

  const exportHar = async () => {
    if (!session) return;
    const text = JSON.stringify(buildHar(session, entries), null, 2);
    const name = `${session.name.replace(/[^\w.-]+/g, '_')}.har`;
    if (bridge.saveFile) {
      const where = await bridge.saveFile(name, text);
      if (where) onNotice(`Saved ${where}`);
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const recordingHere = !!browser?.open && browser.sessionId === sessionId;
  const liveElsewhere = browser?.open && browser.sessionId && browser.sessionId !== sessionId ? browser.sessionId : null;

  const menu = [
    { label: 'Import HAR file…', onSelect: () => fileInput.current?.click() },
    ...(session ? [{ label: 'Export as HAR', onSelect: () => void exportHar() }] : []),
    ...(capture.browser
      ? [
          {
            label: 'Sign out of all sites in the Restless browser',
            onSelect: () => {
              if (window.confirm('Clear cookies, logins and site data in the Restless browser? Your captures are kept.'))
                void capture.browser!.clearData().then(() => onNotice('Signed out everywhere in the Restless browser. Captures are kept.'));
            },
          },
        ]
      : []),
    ...(session
      ? [
          {
            label: 'Delete this capture',
            danger: true,
            onSelect: () => {
              if (window.confirm(`Delete "${session.name}" and its ${session.entryCount} requests?`)) void capture.deleteSession(session.id).then(refreshMeta);
            },
          },
        ]
      : []),
  ];

  const addressForm = (big: boolean) =>
    capture.browser && (
      <form
        className={big ? 'cap-open big' : 'cap-open'}
        onSubmit={(e) => {
          e.preventDefault();
          void openBrowser();
        }}
      >
        <input
          className="input mono"
          spellCheck={false}
          placeholder="Your app's address, e.g. localhost:3000"
          aria-label="Website to record"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button className="btn primary" type="submit">
          {browser?.open ? 'Go' : 'Open and record'}
        </button>
      </form>
    );

  return (
    <div className="capture">
      <div className="cap-toolbar">
        <select className="select cap-session" aria-label="Capture" value={sessionId ?? ''} onChange={(e) => setSessionId(e.target.value || null)} disabled={!sessions.length}>
          {!sessions.length && <option value="">No captures yet</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id} title={s.source === 'har' ? 'Imported HAR file' : 'Recorded in the Restless browser'}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
        {sessions.length > 0 && addressForm(false)}
        <span style={{ flex: 1 }} />
        {browser?.open && (
          <>
            {liveElsewhere && (
              <button className="btn ghost" onClick={() => setSessionId(liveElsewhere)}>
                Show live capture
              </button>
            )}
            <button
              className={`btn ${browser.paused ? '' : 'rec-on'}`}
              aria-pressed={!browser.paused}
              onClick={() => void capture.browser!.setPaused(!browser.paused).then(refreshMeta)}
              title={browser.paused ? 'Recording is paused. Click to record again.' : 'Recording the Restless browser. Click to pause.'}
            >
              <span className={`rec-dot ${browser.paused ? 'idle' : ''}`} /> {browser.paused ? 'Paused' : 'Recording'}
            </button>
            <button className="btn" onClick={() => void newCapture()} title="Finish this capture and start an empty one; the browser stays open">
              New capture
            </button>
          </>
        )}
        <Menu label="More capture actions" items={menu} />
        <input
          ref={fileInput}
          type="file"
          accept=".har,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importHar(f);
            e.target.value = '';
          }}
        />
      </div>

      {!session ? (
        <div className="empty cap-empty">
          <h2>Record what a website sends</h2>
          {capture.browser ? (
            <>
              <p className="muted">Restless opens the site in its own browser window and records every API call and page load, with headers, bodies and timing. Go back through them on the timeline and save any call as a request.</p>
              {addressForm(true)}
              <ul className="plain-list muted">
                <li>localhost works, including https with a self-signed certificate.</li>
                <li>It&rsquo;s a separate browser, so sign in to your site once there. Restless remembers it.</li>
                <li>Already have a HAR file from DevTools?{' '}
                  <button className="link" onClick={() => fileInput.current?.click()}>
                    Import it
                  </button>
                </li>
              </ul>
            </>
          ) : (
            <>
              <p className="muted">Import a HAR file (DevTools → Network → Export HAR) to step through its requests and save any of them as a request.</p>
              <div>
                <button className="btn primary" onClick={() => fileInput.current?.click()}>
                  Import a HAR file
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <Timeline entries={shown} pages={pages} selectedId={selectedId} onSelect={setSelectedId} live={!!session.live && recordingHere} follow={follow} onFollow={setFollow} />
          <div className="cap-split">
            <div className="cap-list">
              <div className="cap-filter">
                <input className="input" placeholder="Filter by URL, method or status" aria-label="Filter captured requests" value={q} onChange={(e) => setQ(e.target.value)} />
                <label title="Hide page loads; show only fetch/XHR calls">
                  <input type="checkbox" checked={apiOnly} onChange={(e) => setApiOnly(e.target.checked)} /> API calls only
                </label>
              </div>
              <div className="cap-rows" role="listbox" aria-label="Captured requests">
                {shown.length === 0 && (
                  <div className="side-empty">
                    {entries.length ? 'Nothing matches the filter.' : session.live ? 'Recording. Use the site in the Restless browser and its API calls appear here.' : 'This capture is empty.'}
                  </div>
                )}
                {shown.map((e) => {
                  const { host, path } = pathOf(e.url);
                  return (
                    <div
                      key={e.id}
                      role="option"
                      aria-selected={e.id === selectedId}
                      className={`cap-row ${e.id === selectedId ? 'sel' : ''}`}
                      onClick={() => {
                        setSelectedId(e.id);
                        setFollow(!!session.live && e.id === shown[shown.length - 1].id);
                      }}
                    >
                      <span className="cap-time">+{((e.startedAt - shown[0].startedAt) / 1000).toFixed(1)}s</span>
                      <span className={`method m-${e.method}`}>{e.method}</span>
                      <span className={`mono cap-status ${e.status ? statusClass(e.status) : 's0'}`}>{e.error ? 'ERR' : (e.status ?? '…')}</span>
                      <span className="cap-path" title={e.url}>
                        {path}
                        <span className="cap-host">{host}</span>
                      </span>
                      <span className="cap-dur">{e.durationMs !== undefined ? formatMs(e.durationMs) : ''}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {selected ? <EntryDetail key={selected.id} entry={selected} collections={collections} onSaveAsRequest={onSaveAsRequest} /> : <div className="empty">Pick a request on the left or on the timeline.</div>}
          </div>
        </>
      )}
    </div>
  );
}
