import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatPath, suggestVariableName, toCurl, type HttpResponse, type HttpTimings, type PathSegment, type ResolvedRequest } from '@restless/core';
import { JsonView } from './JsonView';
import { JsonTree, canRenderTree } from './JsonTree';
import { SaveBar, type Pick } from './SaveBar';
import { copyText, formatBytes, formatMs, statusClass, tryPrettyJson } from '../util';

interface Props {
  response: HttpResponse | null;
  sent: ResolvedRequest | null;
  sending: boolean;
  globalNames: Set<string>;
  onSaveVariable: (pick: Pick, name: string, keepUpdated: boolean) => void;
}

type Tab = 'body' | 'headers' | 'sent' | 'curl';

const PHASES: { key: keyof HttpTimings; label: string; color: string }[] = [
  { key: 'dns', label: 'DNS', color: 'var(--t-dns)' },
  { key: 'connect', label: 'Connect', color: 'var(--t-connect)' },
  { key: 'tls', label: 'TLS', color: 'var(--t-tls)' },
  { key: 'ttfb', label: 'Waiting', color: 'var(--t-wait)' },
  { key: 'download', label: 'Download', color: 'var(--t-download)' },
];

/** The signal line: each phase of the request as a proportional segment. */
function TimingTrace({ t }: { t: HttpTimings }) {
  const phases = PHASES.filter((p) => typeof t[p.key] === 'number' && (t[p.key] as number) >= 0);
  if (phases.length === 0) return null;
  const sum = phases.reduce((s, p) => s + (t[p.key] as number), 0) || 1;
  return (
    <div className="trace" aria-label="Request timing breakdown">
      <div className="trace-line">
        {phases.map((p) => (
          <span key={p.key} title={`${p.label}: ${formatMs(t[p.key] as number)}`} style={{ width: `${((t[p.key] as number) / sum) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="trace-legend">
        {phases.map((p) => (
          <span key={p.key}>
            <i style={{ background: p.color }} />
            {p.label} <b>{formatMs(t[p.key] as number)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ResponseView({ response, sent, sending, globalNames, onSaveVariable }: Props) {
  const [tab, setTab] = useState<Tab>('body');
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const pretty = useMemo(() => (response ? tryPrettyJson(response.body) : null), [response]);
  const parsed = useMemo(() => {
    if (!pretty || !response) return undefined;
    const v: unknown = JSON.parse(response.body);
    return canRenderTree(v) ? v : undefined;
  }, [pretty, response]);

  useEffect(() => setPick(null), [response]);

  const onPick = useCallback((segs: PathSegment[], value: unknown) => {
    setPick({ from: 'body', path: formatPath(segs), value: typeof value === 'string' ? value : JSON.stringify(value), suggested: suggestVariableName(segs) });
  }, []);

  if (sending && !response) {
    return (
      <div className="pane">
        <div className="empty">Sending…</div>
      </div>
    );
  }
  if (!response) {
    return (
      <div className="pane">
        <div className="empty">
          <h2>No response yet</h2>
          <p>Press Send (or Ctrl + Enter). Responses stay on this machine.</p>
        </div>
      </div>
    );
  }

  const curl = sent ? toCurl(sent) : '';
  return (
    <div className="pane" aria-busy={sending}>
      <div className="res-head">
        <span className={`status ${statusClass(response.status)}`}>{response.error ? 'Error' : `${response.status} ${response.statusText}`}</span>
        <span className="metric">
          Time <b>{formatMs(response.timings.total)}</b>
        </span>
        <span className="metric">
          Size <b>{formatBytes(response.size)}</b>
        </span>
        {sending && <span className="metric">Sending again…</span>}
      </div>
      {!response.error && <TimingTrace t={response.timings} />}
      {response.error && <div className="notice bad">{response.error}</div>}
      {response.droppedHeaders && response.droppedHeaders.length > 0 && (
        <div className="notice warn">
          The browser blocked these headers: {response.droppedHeaders.join(', ')}. The desktop app can send them.
        </div>
      )}
      <div className="tabs" role="tablist">
        {(
          [
            ['body', 'Body'],
            ['headers', `Headers`],
            ['sent', 'Sent request'],
            ['curl', 'cURL'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
            {id === 'headers' && <span className="count">{response.headers.length}</span>}
          </button>
        ))}
      </div>
      <div className="pane-body">
        {pick && (tab === 'body' || tab === 'headers') && (
          <SaveBar
            pick={pick}
            existing={globalNames}
            onCancel={() => setPick(null)}
            onSave={(name, keep) => {
              onSaveVariable(pick, name, keep);
              setPick(null);
            }}
          />
        )}
        {tab === 'body' && (
          <>
            {pretty && (
              <div className="toolbar">
                <div className="seg">
                  <button aria-pressed={!raw} onClick={() => setRaw(false)}>
                    Pretty
                  </button>
                  <button aria-pressed={raw} onClick={() => setRaw(true)}>
                    Raw
                  </button>
                </div>
                {!raw && parsed !== undefined && !pick && <span className="pick-hint">Click any value to save it as a variable</span>}
              </div>
            )}
            {pretty && !raw ? (
              parsed !== undefined ? (
                <JsonTree value={parsed} selected={pick?.from === 'body' ? pick.path : null} onPick={onPick} />
              ) : (
                <JsonView text={pretty} />
              )
            ) : (
              <pre className="code-view">{response.body || '(empty body)'}</pre>
            )}
          </>
        )}
        {tab === 'headers' && (
          <HeaderTable
            headers={response.headers}
            onSave={([k, v]) => setPick({ from: 'header', path: k, value: v, suggested: k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'header' })}
          />
        )}
        {tab === 'sent' && sent && (
          <>
            <p className="mono" style={{ marginTop: 0 }}>
              <span className={`method m-${sent.method}`}>{sent.method}</span> {response.url || sent.url}
            </p>
            <HeaderTable headers={sent.headers} />
            {sent.body && <pre className="code-view" style={{ marginTop: 10 }}>{sent.body}</pre>}
          </>
        )}
        {tab === 'curl' && (
          <>
            <div className="toolbar">
              <button
                className="btn small"
                onClick={async () => {
                  setCopied(await copyText(curl));
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? 'Copied' : 'Copy cURL'}
              </button>
            </div>
            <pre className="code-view">{curl}</pre>
          </>
        )}
      </div>
    </div>
  );
}

function HeaderTable({ headers, onSave }: { headers: [string, string][]; onSave?: (h: [string, string]) => void }) {
  if (headers.length === 0) return <p style={{ color: 'var(--text-3)' }}>No headers.</p>;
  return (
    <table className="headers-table">
      <tbody>
        {headers.map(([k, v], i) => (
          <tr key={i}>
            <td>{k}</td>
            <td>{v}</td>
            {onSave && (
              <td className="hdr-save">
                <button className="btn ghost small" onClick={() => onSave([k, v])} title={`Save the ${k} header as a variable`}>
                  Save
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
