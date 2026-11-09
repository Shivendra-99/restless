import { useEffect, useRef, useState } from 'react';
import { cleanVariableName } from '@restless/core';

export interface Pick {
  from: 'body' | 'header';
  /** JSON path for body values, header name for headers. */
  path: string;
  value: string;
  suggested: string;
}

interface Props {
  pick: Pick;
  existing: Set<string>;
  onSave: (name: string, keepUpdated: boolean) => void;
  onCancel: () => void;
}

const short = (v: string) => (v.length > 60 ? `${v.slice(0, 60)}…` : v);

/** Shown when a value in the response is clicked: name it, choose whether it refreshes, save. */
export function SaveBar({ pick, existing, onSave, onCancel }: Props) {
  const [name, setName] = useState(pick.suggested);
  const [keep, setKeep] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(pick.suggested);
    input.current?.focus();
    input.current?.select();
  }, [pick]);

  const clean = cleanVariableName(name);
  const exists = existing.has(clean);
  const source = pick.from === 'header' ? `header ${pick.path}` : pick.path ? `body.${pick.path}`.replace('body.[', 'body[') : 'the whole body';

  return (
    <form
      className="save-bar"
      aria-label="Save value as a variable"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean) onSave(clean, keep);
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <div className="save-bar-row">
        <span className="save-bar-title">Save as a variable</span>
        <code className="save-bar-value" title={pick.value}>
          {short(pick.value) || '(empty)'}
        </code>
        <span className="save-bar-src">from {source}</span>
      </div>
      <div className="save-bar-row">
        <label className="save-bar-name">
          <span className="mono">{'{{'}</span>
          <input ref={input} className="input mono" value={name} aria-label="Variable name" spellCheck={false} onChange={(e) => setName(e.target.value)} />
          <span className="mono">{'}}'}</span>
        </label>
        <label className="save-bar-keep">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          Update it every time this request is sent
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary small" disabled={!clean}>
          {exists ? `Update {{${clean}}}` : 'Save variable'}
        </button>
      </div>
      {exists && <div className="save-bar-hint">{`{{${clean}}}`} already exists; its value will be replaced.</div>}
    </form>
  );
}
