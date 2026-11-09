import { useState, type ReactNode } from 'react';

interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
}

interface Props {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}

const primaryType = (s: JsonSchema) => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type);

/** Form generated from a tool's inputSchema. Top-level scalars get real inputs; nested values get a JSON box. */
export function SchemaForm({ schema, value, onChange }: Props) {
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  if (props.length === 0) return <p style={{ margin: 0, color: 'var(--text-3)' }}>This tool takes no arguments.</p>;

  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };

  return (
    <div className="schema-form">
      {props.map(([name, s]) => {
        const t = primaryType(s);
        const id = `arg-${name}`;
        const label = (
          <>
            <span className="mono" style={{ color: 'var(--text)' }}>
              {name}
              {required.has(name) && <span className="req"> *</span>}
            </span>
            {t && <span className="hint"> {Array.isArray(s.type) ? s.type.join(' | ') : t}</span>}
          </>
        );
        let control: ReactNode;
        if (s.enum) {
          control = (
            <select id={id} className="select" value={value[name] === undefined ? '' : JSON.stringify(value[name])} onChange={(e) => set(name, e.target.value === '' ? undefined : JSON.parse(e.target.value))}>
              <option value="">{required.has(name) ? 'Choose…' : '(not set)'}</option>
              {s.enum.map((opt) => (
                <option key={JSON.stringify(opt)} value={JSON.stringify(opt)}>
                  {String(opt)}
                </option>
              ))}
            </select>
          );
        } else if (t === 'boolean') {
          control = (
            <select id={id} className="select" value={value[name] === undefined ? '' : String(value[name])} onChange={(e) => set(name, e.target.value === '' ? undefined : e.target.value === 'true')}>
              <option value="">(not set)</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          );
        } else if (t === 'number' || t === 'integer') {
          control = (
            <input
              id={id}
              className="input mono"
              type="number"
              step={t === 'integer' ? 1 : 'any'}
              min={s.minimum}
              max={s.maximum}
              value={value[name] === undefined ? '' : String(value[name])}
              onChange={(e) => set(name, e.target.value === '' ? undefined : Number(e.target.value))}
            />
          );
        } else if (t === 'string') {
          const v = value[name] === undefined ? '' : String(value[name]);
          control =
            v.length > 60 || v.includes('\n') ? (
              <textarea id={id} className="textarea" rows={4} value={v} onChange={(e) => set(name, e.target.value)} />
            ) : (
              <input id={id} className="input mono" value={v} onChange={(e) => set(name, e.target.value)} />
            );
        } else {
          control = <JsonField id={id} value={value[name]} onChange={(v) => set(name, v)} />;
        }
        return (
          <label key={name} className="field" htmlFor={id}>
            <span>{label}</span>
            {control}
            {s.description && <span className="hint">{s.description}</span>}
          </label>
        );
      })}
    </div>
  );
}

function JsonField({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea
        id={id}
        className="textarea"
        rows={4}
        value={text}
        placeholder="JSON value"
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === '') {
            setBad(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <span className="hint" style={{ color: 'var(--warn)' }}>Not valid JSON yet</span>}
    </>
  );
}
