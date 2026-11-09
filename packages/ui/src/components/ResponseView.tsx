import { useMemo, useState } from 'react';
import { toCurl, type HttpResponse, type HttpTimings, type ResolvedRequest } from '@restless/core';
import { JsonView } from './JsonView';
import { copyText, formatBytes, formatMs, statusClass, tryPrettyJson } from '../util';

interface Props {
  response: HttpResponse | null;
  sent: ResolvedRequest | null;
  sending: boolean;
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

export function ResponseView({ response, sent, sending }: Props) {
  const [tab, setTab] = useState<Tab>('body');
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const pretty = useMemo(() => (response ? tryPrettyJson(response.body) : null), [response]);

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
              </div>
            )}
            {pretty && !raw ? <JsonView text={pretty} /> : <pre className="code-view">{response.body || '(empty body)'}</pre>}
          </>
        )}
        {tab === 'headers' && <HeaderTable headers={response.headers} />}
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

function HeaderTable({ headers }: { headers: [string, string][] }) {
  if (headers.length === 0) return <p style={{ color: 'var(--text-3)' }}>No headers.</p>;
  return (
    <table className="headers-table">
      <tbody>
        {headers.map(([k, v], i) => (
          <tr key={i}>
            <td>{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
