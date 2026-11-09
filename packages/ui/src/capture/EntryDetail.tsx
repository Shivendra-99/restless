import { useMemo, useState } from 'react';
import { capturedToResolved, getHeader, responseText, toCurl, type CapturedEntry, type Collection } from '@restless/core';
import { JsonView } from '../components/JsonView';
import { Menu } from '../components/Menu';
import { copyText, formatBytes, formatMs, statusClass, tryPrettyJson } from '../util';
import { clock } from './Timeline';

interface Props {
  entry: CapturedEntry;
  collections: Collection[];
  onSaveAsRequest: (entry: CapturedEntry, collectionId: string | null) => void;
}

type Tab = 'response' | 'request' | 'headers';

function Headers({ list }: { list: [string, string][] }) {
  if (!list.length) return <p className="muted">No headers recorded.</p>;
  return (
    <table className="headers-table">
      <tbody>
        {list.map(([k, v], i) => (
          <tr key={i}>
            <td>{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Body({ text }: { text: string }) {
  const pretty = useMemo(() => tryPrettyJson(text), [text]);
  return pretty ? <JsonView text={pretty} /> : <pre className="code-view">{text}</pre>;
}

/** One captured request as it was at that moment, with ways to reuse it. */
export function EntryDetail({ entry: e, collections, onSaveAsRequest }: Props) {
  const [tab, setTab] = useState<Tab>('response');
  const [copied, setCopied] = useState(false);
  const text = responseText(e);
  const mime = e.mimeType ?? getHeader(e.responseHeaders, 'content-type') ?? '';
  const isImage = e.responseBodyBase64 && /^image\//.test(mime);

  return (
    <div className="cap-detail">
      <div className="cap-detail-head">
        <div className="cap-detail-line">
          <span className={`method m-${e.method}`}>{e.method}</span>
          <span className={`status ${e.status ? statusClass(e.status) : 's0'}`}>{e.error ? 'Failed' : e.status ? `${e.status} ${e.statusText ?? ''}` : 'Pending'}</span>
          <span className="metric">
            {clock(e.startedAt)}
            {e.durationMs !== undefined && <> · {formatMs(e.durationMs)}</>}
            {e.size !== undefined && e.size > 0 && <> · {formatBytes(e.size)}</>} · {e.type}
          </span>
          <span style={{ flex: 1 }} />
          <SaveMenu collections={collections} onPick={(cid) => onSaveAsRequest(e, cid)} />
          <button
            className="btn small"
            onClick={async () => {
              setCopied(await copyText(toCurl(capturedToResolved(e))));
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy cURL'}
          </button>
        </div>
        <div className="cap-url mono">{e.url}</div>
        {e.error && <div className="notice bad" style={{ margin: '6px 0 0' }}>{e.error}</div>}
      </div>
      <div className="tabs" role="tablist">
        {(
          [
            ['response', 'Response'],
            ['request', 'Request'],
            ['headers', 'Response headers'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
            {id === 'headers' && <span className="count">{e.responseHeaders.length}</span>}
          </button>
        ))}
      </div>
      <div className="pane-body">
        {e.note && <p className="cap-note">{e.note}</p>}
        {tab === 'response' &&
          (isImage ? (
            <img className="cap-img" alt="Response image" src={`data:${mime};base64,${e.responseBody}`} />
          ) : text !== null ? (
            text ? <Body text={text} /> : <p className="muted">Empty response body.</p>
          ) : e.responseBody !== undefined ? (
            <p className="muted">Binary response ({mime || 'unknown type'}), {formatBytes(Math.round((e.responseBody.length * 3) / 4))}.</p>
          ) : (
            !e.note && <p className="muted">No response body was recorded.</p>
          ))}
        {tab === 'request' && (
          <>
            <Headers list={e.requestHeaders} />
            {e.requestBody !== undefined && e.requestBody !== '' && (
              <div style={{ marginTop: 12 }}>
                <div className="cap-sub">Body</div>
                <Body text={e.requestBody} />
              </div>
            )}
          </>
        )}
        {tab === 'headers' && <Headers list={e.responseHeaders} />}
      </div>
    </div>
  );
}

function SaveMenu({ collections, onPick }: { collections: Collection[]; onPick: (collectionId: string | null) => void }) {
  if (collections.length <= 1) {
    return (
      <button className="btn primary small" onClick={() => onPick(collections[0]?.id ?? null)} title="Save it as a request you can edit and send again">
        Save as request
      </button>
    );
  }
  return (
    <Menu
      label="Save it as a request in a collection"
      className="btn primary small"
      trigger={<>Save as request ▾</>}
      items={collections.map((c) => ({ label: `Save in ${c.name}`, onSelect: () => onPick(c.id) }))}
    />
  );
}
