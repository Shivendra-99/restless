import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildHar,
  isApiType,
  parseHar,
  type Bridge,
  type CaptureBridge,
  type CapturedEntry,
  type CaptureSession,
  type CaptureTab,
  type Collection,
  type DesktopLinkStatus,
  type PairedBrowser,
  type RecordingInfo,
  type RewindStatus,
} from '@restless/core';
import { Dialog } from '../components/Dialog';
import { Menu } from '../components/Menu';
import { errorText, formatMs, statusClass } from '../util';
import { EntryDetail } from './EntryDetail';
import { Timeline, clock } from './Timeline';

interface Props {
  bridge: Bridge;
  capture: CaptureBridge;
  collections: Collection[];
  /** Show this session (e.g. opened from the DevTools panel). */
  focusSessionId?: string | null;
  onSaveAsRequest: (entry: CapturedEntry, collectionId: string | null) => void;
  onNotice: (text: string) => void;
}

const SOURCE: Record<CaptureSession['source'], string> = { recorder: 'Recorded', rewind: 'Rewind', devtools: 'DevTools', har: 'HAR file' };

function sessionLabel(s: CaptureSession) {
  const d = new Date(s.startedAt);
  return `${s.live ? '● ' : ''}${s.name}${s.device ? ` · ${s.device}` : ''} · ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} · ${s.entryCount}`;
}

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return { host: u.host, path: `${u.pathname}${u.search}` };
  } catch {
    return { host: '', path: url };
  }
}

export function CaptureView({ bridge, capture, collections, focusSessionId, onSaveAsRequest, onNotice }: Props) {
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(focusSessionId ?? null);
  useEffect(() => {
    if (focusSessionId) setSessionId(focusSessionId);
  }, [focusSessionId]);
  const [entries, setEntries] = useState<CapturedEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState('');
  const [apiOnly, setApiOnly] = useState(true);
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [rewind, setRewind] = useState<RewindStatus | null>(null);
  const [desktop, setDesktop] = useState<DesktopLinkStatus | null>(null);
  const [paired, setPaired] = useState<PairedBrowser[]>([]);
  const [dialog, setDialog] = useState<'record' | 'rewind' | 'desktop' | 'pair' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const session = sessions.find((s) => s.id === sessionId) ?? null;

  const refreshMeta = useCallback(async () => {
    const list = await capture.listSessions();
    setSessions(list);
    if (capture.recordings) setRecordings(await capture.recordings());
    if (capture.rewindStatus) setRewind(await capture.rewindStatus());
    if (capture.desktop) setDesktop(await capture.desktop.status());
    if (capture.pairing) setPaired(await capture.pairing.browsers());
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
      if (dialog || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.getAttribute('role') === 'slider') return;
      const next = e.key === 'ArrowLeft' ? selIndex - 1 : e.key === 'ArrowRight' ? selIndex + 1 : null;
      if (next === null || next < 0 || next >= shown.length) return;
      e.preventDefault();
      setSelectedId(shown[next].id);
      setFollow(!!session?.live && next === shown.length - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selIndex, shown, dialog, session?.live]);

  // Keep the selected row in view while scrubbing.
  useEffect(() => {
    document.querySelector('.cap-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const recordingHere = recordings.find((r) => r.sessionId === sessionId);

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

  // Must run straight from the click: the browser only shows its permission prompt for a user action.
  const openRecord = () => {
    if (!capture.ensureRecordAccess) return setDialog('record');
    void capture.ensureRecordAccess().then(
      (ok) => (ok ? setDialog('record') : onNotice('Recording needs permission to debug tabs. Nothing was recorded.')),
      (e) => onNotice(errorText(e)),
    );
  };

  const grab = async (tabId?: number) => {
    const id = await capture.grabRewind!(tabId);
    if (!id) onNotice('Nothing in the rewind buffer yet. It keeps API calls from the last 5 minutes once rewind is on.');
    else {
      setSessionId(id);
      await refreshMeta();
    }
  };

  const sessionMenu = [
    { label: 'Import HAR file…', onSelect: () => fileInput.current?.click() },
    ...(session ? [{ label: 'Export as HAR', onSelect: () => void exportHar() }] : []),
    ...(session && capture.desktop && desktop?.connected ? [{ label: 'Send to desktop app', onSelect: () => void capture.desktop!.resend(session.id).then(() => onNotice('Sent to the desktop app'), (e) => onNotice(errorText(e))) }] : []),
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

  return (
    <div className="capture">
      <div className="cap-toolbar">
        <select className="select cap-session" aria-label="Capture session" value={sessionId ?? ''} onChange={(e) => setSessionId(e.target.value || null)} disabled={!sessions.length}>
          {!sessions.length && <option value="">No captures yet</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id} title={SOURCE[s.source]}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>

        {capture.startRecording &&
          (recordingHere ? (
            <button className="btn rec-on" onClick={() => void capture.stopRecording!(recordingHere.tabId).then(refreshMeta)}>
              <span className="rec-dot" /> Stop recording
            </button>
          ) : (
            <button className="btn" onClick={openRecord}>
              <span className="rec-dot idle" /> Record a tab
            </button>
          ))}

        {capture.grabRewind &&
          (rewind?.enabled ? (
            <span className="btn-group">
              <button className="btn" onClick={() => void grab()} title="Turn the last 5 minutes of API calls into a capture">
                ⏪ Rewind 5 min <span className="count">{rewind.buffered}</span>
              </button>
              <Menu label="Rewind options" className="btn" items={[{ label: 'Turn rewind off', onSelect: () => void capture.setRewind!(false).then(refreshMeta) }]} />
            </span>
          ) : (
            <button className="btn ghost" onClick={() => setDialog('rewind')} title="Keep the last few minutes so you can go back before you pressed Record">
              ⏪ Rewind: off
            </button>
          ))}

        {capture.pairing && (
          <button className="btn" onClick={() => setDialog('pair')}>
            Connect browser
          </button>
        )}

        <span style={{ flex: 1 }} />
        {capture.pairing && paired.length > 0 && (
          <button className="chip on" onClick={() => setDialog('pair')} title="Browsers that send their captures to this app">
            {paired.length === 1 ? `${paired[0].name} connected` : `${paired.length} browsers connected`}
          </button>
        )}
        {capture.desktop && (
          <button className={`chip ${desktop?.connected ? (desktop.reachable ? 'on' : 'warn') : ''}`} onClick={() => setDialog('desktop')} title="Send captures to the Restless desktop app">
            {desktop?.connected ? (desktop.reachable ? 'Desktop app: connected' : 'Desktop app: not running') : 'Send to desktop app'}
          </button>
        )}
        <Menu label="More capture actions" items={sessionMenu} />
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
        <CaptureEmpty capture={capture} onRecord={openRecord} onRewind={() => setDialog('rewind')} onPair={() => setDialog('pair')} onImport={() => fileInput.current?.click()} />
      ) : (
        <>
          <Timeline entries={shown} selectedId={selectedId} onSelect={setSelectedId} recordingFrom={session.recordingFrom} live={!!session.live} follow={follow} onFollow={setFollow} />
          <div className="cap-split">
            <div className="cap-list">
              <div className="cap-filter">
                <input className="input" placeholder="Filter by URL, method or status" aria-label="Filter captured requests" value={q} onChange={(e) => setQ(e.target.value)} />
                <label title="Show only fetch/XHR calls (hide pages, scripts, images)">
                  <input type="checkbox" checked={apiOnly} onChange={(e) => setApiOnly(e.target.checked)} /> API calls only
                </label>
              </div>
              <div className="cap-rows" role="listbox" aria-label="Captured requests">
                {shown.length === 0 && (
                  <div className="side-empty">{entries.length ? 'Nothing matches the filter.' : session.live ? 'Recording… use the page and API calls will appear here.' : 'This capture is empty.'}</div>
                )}
                {shown.map((e, i) => {
                  const { host, path } = pathOf(e.url);
                  const startsRecording = !e.before && i > 0 && shown[i - 1].before;
                  return (
                    <Fragment key={e.id}>
                    {startsRecording && <div className="cap-rec-line" aria-hidden="true">Recording started</div>}
                    <div
                      role="option"
                      aria-selected={e.id === selectedId}
                      className={`cap-row ${e.id === selectedId ? 'sel' : ''} ${e.before ? 'before' : ''}`}
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
                    </Fragment>
                  );
                })}
              </div>
            </div>
            {selected ? <EntryDetail key={selected.id} entry={selected} collections={collections} onSaveAsRequest={onSaveAsRequest} /> : <div className="empty">Pick a request on the left or on the timeline.</div>}
          </div>
        </>
      )}

      {dialog === 'record' && capture.listTabs && (
        <RecordDialog
          capture={capture}
          apiOnly={apiOnly}
          onApiOnly={setApiOnly}
          onClose={() => setDialog(null)}
          onStarted={(id) => {
            setDialog(null);
            setSessionId(id);
            setFollow(true);
            void refreshMeta();
          }}
        />
      )}
      {dialog === 'rewind' && capture.setRewind && (
        <Dialog title="Rewind" onClose={() => setDialog(null)} footer={<><button className="btn ghost" onClick={() => setDialog(null)}>Not now</button><button className="btn primary" onClick={() => void capture.setRewind!(true).then((on) => { setDialog(null); void refreshMeta(); onNotice(on ? 'Rewind is on. It keeps the last 5 minutes of API calls.' : 'Rewind needs access to your sites. It stays off.'); })}>Turn on rewind</button></>}>
          <p style={{ margin: 0 }}>Forgot to press Record? With rewind on, Restless keeps the last 5 minutes of API calls from your tabs, so you can go back and grab requests that already happened.</p>
          <ul className="plain-list">
            <li>Kept in memory only and cleared when the browser closes. Nothing is saved unless you grab it.</li>
            <li>Response bodies aren&rsquo;t kept for these (the browser doesn&rsquo;t expose them without recording). URL, headers, request body and status are.</li>
            <li>The browser will ask to let Restless read data on all sites; that is what lets it see those requests.</li>
          </ul>
        </Dialog>
      )}
      {dialog === 'desktop' && capture.desktop && <DesktopDialog capture={capture} status={desktop} onClose={() => setDialog(null)} onChanged={refreshMeta} onNotice={onNotice} />}
      {dialog === 'pair' && capture.pairing && (
        <PairDialog
          capture={capture}
          onClose={() => {
            setDialog(null);
            void refreshMeta();
          }}
        />
      )}
    </div>
  );
}

function CaptureEmpty({ capture, onRecord, onRewind, onPair, onImport }: { capture: CaptureBridge; onRecord: () => void; onRewind: () => void; onPair: () => void; onImport: () => void }) {
  if (capture.pairing) {
    return (
      <div className="empty">
        <h2>Capture requests from your browser</h2>
        <ol className="steps">
          <li>Add the Restless extension to Chrome or Edge.</li>
          <li>Press Connect browser here and type the code into the extension (Capture, then Send to desktop app).</li>
          <li>Record a tab in the extension. Its API calls show up here as they happen.</li>
        </ol>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={onPair}>
            Connect browser
          </button>
          <button className="btn" onClick={onImport}>
            Import a HAR file
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="empty">
      <h2>Capture what your web app sends</h2>
      <ol className="steps">
        <li>Open your app in another tab.</li>
        <li>Press Record a tab here, or click the Restless icon in the toolbar while on that tab.</li>
        <li>Use your app. Every API call appears here with its response, and you can step back through them on the timeline.</li>
      </ol>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={onRecord}>
          Record a tab
        </button>
        {capture.setRewind && (
          <button className="btn" onClick={onRewind}>
            Turn on rewind
          </button>
        )}
        <button className="btn ghost" onClick={onImport}>
          Import a HAR file
        </button>
      </div>
      <p className="muted" style={{ marginTop: 16 }}>
        Using DevTools? Press F12 and open the Restless tab: it picks up everything since DevTools was opened.
      </p>
    </div>
  );
}

function RecordDialog({ capture, apiOnly, onApiOnly, onClose, onStarted }: { capture: CaptureBridge; apiOnly: boolean; onApiOnly: (v: boolean) => void; onClose: () => void; onStarted: (sessionId: string) => void }) {
  const [tabs, setTabs] = useState<CaptureTab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void capture.listTabs!().then(setTabs, (e) => setError(errorText(e)));
  }, [capture]);
  return (
    <Dialog title="Record a tab" onClose={onClose}>
      <p style={{ margin: 0 }}>Pick the tab with your app. While it records, the browser shows a bar saying Restless is debugging it; that&rsquo;s expected, and closing the bar stops recording.</p>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" checked={apiOnly} onChange={(e) => onApiOnly(e.target.checked)} /> Only API calls (fetch/XHR), not pages, scripts and images
      </label>
      {error && <div className="notice bad" style={{ margin: 0 }}>{error}</div>}
      {!tabs && !error && <p className="muted">Looking for tabs…</p>}
      {tabs && tabs.length === 0 && <p className="muted">No website tabs are open. Open your app in a tab, then come back here.</p>}
      <div className="tab-list">
        {tabs?.map((t) => (
          <button
            key={t.id}
            className="tab-pick"
            onClick={() =>
              void capture.startRecording!(t.id, { apiOnly }).then(onStarted, (e) => setError(`Could not record this tab: ${errorText(e)}`))
            }
          >
            <span className="tab-title">{t.title || t.url}</span>
            <span className="tab-url mono">{t.url}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function DesktopDialog({ capture, status, onClose, onChanged, onNotice }: { capture: CaptureBridge; status: DesktopLinkStatus | null; onClose: () => void; onChanged: () => Promise<void>; onNotice: (t: string) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = !!status?.connected;
  return (
    <Dialog title="Send captures to the desktop app" onClose={onClose}>
      {connected ? (
        <>
          <p style={{ margin: 0 }}>
            {status?.reachable ? 'Connected. New captures are sent to the Restless desktop app as they happen.' : 'Connected, but the desktop app is not answering. Open it; captures made meanwhile can be sent again from the ⋯ menu.'}
          </p>
          <div>
            <button className="btn danger" onClick={() => void capture.desktop!.disconnect().then(onChanged).then(onClose)}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <form
          style={{ display: 'grid', gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            capture
              .desktop!.connect(code.replace(/\D/g, ''))
              .then(async () => {
                await onChanged();
                onNotice('Connected to the desktop app');
                onClose();
              })
              .catch((err) => setError(errorText(err)))
              .finally(() => setBusy(false));
          }}
        >
          <ol className="steps" style={{ margin: 0 }}>
            <li>Open the Restless desktop app and go to Capture.</li>
            <li>Press Connect browser. It shows a 6-digit code.</li>
            <li>Type that code here.</li>
          </ol>
          <input className="input pair-input mono" inputMode="numeric" autoComplete="off" placeholder="123 456" aria-label="Pairing code" value={code} onChange={(e) => setCode(e.target.value)} />
          {error && <div className="notice bad" style={{ margin: 0 }}>{error}</div>}
          <div>
            <button className="btn primary" type="submit" disabled={busy || code.replace(/\D/g, '').length !== 6}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function PairDialog({ capture, onClose }: { capture: CaptureBridge; onClose: () => void }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [browsers, setBrowsers] = useState<PairedBrowser[]>([]);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => setBrowsers(await capture.pairing!.browsers()), [capture]);
  const fresh = useCallback(async () => setCode(await capture.pairing!.newCode()), [capture]);
  useEffect(() => {
    void fresh();
    void load();
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 1000);
    return () => clearInterval(t);
  }, [fresh, load]);
  const left = code ? Math.max(0, Math.round((code.expiresAt - now) / 1000)) : 0;
  return (
    <Dialog title="Connect a browser" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <ol className="steps" style={{ margin: 0 }}>
        <li>In Chrome or Edge, open the Restless extension and go to Capture.</li>
        <li>Press Send to desktop app and type this code:</li>
      </ol>
      <div className="pair-code mono" aria-live="polite">
        {code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : '…'}
      </div>
      <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
        {left > 0 ? `Works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} and only once.` : 'This code expired.'}{' '}
        <button className="link" onClick={() => void fresh()}>
          New code
        </button>
      </p>
      <div>
        <div className="cap-sub">Connected browsers</div>
        {browsers.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>None yet.</p>
        ) : (
          browsers.map((b) => (
            <div key={b.id} className="auto-row">
              <span>
                {b.name}, connected {new Date(b.pairedAt).toLocaleString()}
                {b.lastSeenAt ? `, last capture ${clock(b.lastSeenAt)}` : ''}
              </span>
              <button className="link" onClick={() => void capture.pairing!.remove(b.id).then(load)}>
                Disconnect
              </button>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
