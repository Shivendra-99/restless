import { useState, type ClipboardEvent } from 'react';
import { HTTP_METHODS, parseCurl, type BodyMode, type HttpMethod, type RequestItem } from '@restless/core';
import { KeyValueTable } from './KeyValueTable';
import { tryPrettyJson } from '../util';

interface Props {
  item: RequestItem;
  onChange: (item: RequestItem) => void;
  onSend: () => void;
  sending: boolean;
  onCancel?: () => void;
  unresolved: string[];
  onNotice: (text: string) => void;
}

type Tab = 'params' | 'headers' | 'body' | 'auth';

export function RequestEditor({ item, onChange, onSend, sending, onCancel, unresolved, onNotice }: Props) {
  const [tab, setTab] = useState<Tab>(item.body.mode !== 'none' ? 'body' : 'params');
  const set = (patch: Partial<RequestItem>) => onChange({ ...item, ...patch });

  const onUrlPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/^\s*curl\s/.test(text)) return;
    e.preventDefault();
    try {
      const { request, warnings } = parseCurl(text);
      onChange({ ...request, id: item.id, folder: item.folder, name: item.name === 'New request' ? request.name : item.name });
      setTab(request.body.mode !== 'none' ? 'body' : 'headers');
      onNotice(warnings.length ? `Imported from cURL. ${warnings.join('. ')}` : 'Imported from cURL');
    } catch (err) {
      onNotice(`Could not read that cURL command: ${(err as Error).message}`);
    }
  };

  const counts = {
    params: item.params.filter((p) => p.enabled && p.key).length,
    headers: item.headers.filter((h) => h.enabled && h.key).length,
  };

  return (
    <div className="pane">
      <div className="req-name">
        <input value={item.name} aria-label="Request name" onChange={(e) => set({ name: e.target.value })} />
      </div>
      <form
        className="urlbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (!sending) onSend();
        }}
      >
        <select className={`select m-${item.method}`} value={item.method} aria-label="Method" onChange={(e) => set({ method: e.target.value as HttpMethod })}>
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className="input url"
          value={item.url}
          placeholder="https://api.example.com/users   (or paste a cURL command)"
          aria-label="URL"
          spellCheck={false}
          onPaste={onUrlPaste}
          onChange={(e) => set({ url: e.target.value })}
        />
        {sending ? (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!item.url.trim()}>
            Send
          </button>
        )}
      </form>
      {unresolved.length > 0 && (
        <div className="notice warn" role="status">
          Not defined in the active environment: {unresolved.map((v) => `{{${v}}}`).join(', ')}
        </div>
      )}
      <div className="tabs" role="tablist">
        {(['params', 'headers', 'body', 'auth'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
            {t === 'params' && counts.params > 0 && <span className="count">{counts.params}</span>}
            {t === 'headers' && counts.headers > 0 && <span className="count">{counts.headers}</span>}
            {t === 'body' && item.body.mode !== 'none' && <span className="count">{item.body.mode}</span>}
            {t === 'auth' && item.auth.type !== 'none' && <span className="count">{item.auth.type}</span>}
          </button>
        ))}
      </div>
      <div className="pane-body">
        {tab === 'params' && <KeyValueTable label="Query params" rows={item.params} onChange={(params) => set({ params })} />}
        {tab === 'headers' && <KeyValueTable label="Headers" rows={item.headers} onChange={(headers) => set({ headers })} />}
        {tab === 'body' && <BodyEditor item={item} set={set} />}
        {tab === 'auth' && <AuthEditor item={item} set={set} />}
      </div>
    </div>
  );
}

function BodyEditor({ item, set }: { item: RequestItem; set: (p: Partial<RequestItem>) => void }) {
  const modes: { id: BodyMode; label: string }[] = [
    { id: 'none', label: 'None' },
    { id: 'json', label: 'JSON' },
    { id: 'text', label: 'Text' },
    { id: 'form-urlencoded', label: 'Form (urlencoded)' },
  ];
  const b = item.body;
  const jsonInvalid = b.mode === 'json' && b.text.trim() !== '' && !b.text.includes('{{') && tryPrettyJson(b.text) === null;
  return (
    <>
      <div className="body-modes" role="radiogroup" aria-label="Body type">
        {modes.map((m) => (
          <label key={m.id}>
            <input type="radio" name="body-mode" checked={b.mode === m.id} onChange={() => set({ body: { ...b, mode: m.id } })} />
            {m.label}
          </label>
        ))}
        {b.mode === 'json' && (
          <button
            className="btn ghost small"
            onClick={() => {
              const pretty = tryPrettyJson(b.text);
              if (pretty) set({ body: { ...b, text: pretty } });
            }}
          >
            Format
          </button>
        )}
      </div>
      {(b.mode === 'json' || b.mode === 'text') && (
        <>
          <textarea
            className="textarea"
            rows={12}
            spellCheck={false}
            aria-label="Request body"
            value={b.text}
            placeholder={b.mode === 'json' ? '{\n  "name": "{{username}}"\n}' : ''}
            onChange={(e) => set({ body: { ...b, text: e.target.value } })}
          />
          {jsonInvalid && <div className="notice warn" style={{ margin: '6px 0 0' }}>This is not valid JSON yet. It will still be sent as typed.</div>}
        </>
      )}
      {b.mode === 'form-urlencoded' && <KeyValueTable label="Form fields" rows={b.form} onChange={(form) => set({ body: { ...b, form } })} />}
      {b.mode === 'none' && <p style={{ color: 'var(--text-3)', margin: 0 }}>This request has no body.</p>}
    </>
  );
}

function AuthEditor({ item, set }: { item: RequestItem; set: (p: Partial<RequestItem>) => void }) {
  const a = item.auth;
  return (
    <div className="auth-grid">
      <label className="field">
        Type
        <select
          className="select"
          value={a.type}
          onChange={(e) => {
            const t = e.target.value;
            if (t === 'none') set({ auth: { type: 'none' } });
            if (t === 'bearer') set({ auth: { type: 'bearer', token: '' } });
            if (t === 'basic') set({ auth: { type: 'basic', username: '', password: '' } });
            if (t === 'apikey') set({ auth: { type: 'apikey', key: 'X-API-Key', value: '', in: 'header' } });
          }}
        >
          <option value="none">No auth</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic auth</option>
          <option value="apikey">API key</option>
        </select>
      </label>
      {a.type === 'bearer' && (
        <label className="field">
          Token
          <input className="input mono" value={a.token} placeholder="{{token}}" onChange={(e) => set({ auth: { ...a, token: e.target.value } })} />
          <span className="hint">Tip: keep the real token in an environment variable marked secret.</span>
        </label>
      )}
      {a.type === 'basic' && (
        <>
          <label className="field">
            Username
            <input className="input mono" value={a.username} onChange={(e) => set({ auth: { ...a, username: e.target.value } })} />
          </label>
          <label className="field">
            Password
            <input className="input mono" type="password" value={a.password} onChange={(e) => set({ auth: { ...a, password: e.target.value } })} />
          </label>
        </>
      )}
      {a.type === 'apikey' && (
        <>
          <label className="field">
            Key
            <input className="input mono" value={a.key} onChange={(e) => set({ auth: { ...a, key: e.target.value } })} />
          </label>
          <label className="field">
            Value
            <input className="input mono" value={a.value} placeholder="{{apiKey}}" onChange={(e) => set({ auth: { ...a, value: e.target.value } })} />
          </label>
          <label className="field">
            Send in
            <select className="select" value={a.in} onChange={(e) => set({ auth: { ...a, in: e.target.value as 'header' | 'query' } })}>
              <option value="header">Header</option>
              <option value="query">Query param</option>
            </select>
          </label>
        </>
      )}
    </div>
  );
}
