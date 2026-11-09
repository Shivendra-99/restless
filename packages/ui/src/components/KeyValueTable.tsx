import { useEffect, useRef, type ReactNode } from 'react';
import type { KeyValue } from '@restless/core';

interface Props<T extends KeyValue> {
  rows: T[];
  onChange: (rows: T[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Optional extra control per row (e.g. the "only on this computer" toggle for variables). */
  extra?: (row: T, index: number) => ReactNode;
  label: string;
  /** Highlight this row and put the cursor in its value. */
  focusKey?: string;
}

/** Editable key/value list with a trailing blank row that turns into a real row as you type. Extra fields on rows are kept. */
export function KeyValueTable<T extends KeyValue>({ rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', extra, label, focusKey }: Props<T>) {
  const update = (i: number, patch: Partial<KeyValue>) => {
    if (i === rows.length) onChange([...rows, { key: '', value: '', enabled: true, ...patch } as T]);
    else onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const all = [...rows, { key: '', value: '', enabled: true } as T];

  // Focus the highlighted row once it exists (it may be added right after this table first renders).
  const focusInput = useRef<HTMLInputElement>(null);
  const hasFocusRow = !!focusKey && rows.some((r) => r.key === focusKey);
  useEffect(() => {
    if (hasFocusRow) focusInput.current?.focus();
  }, [hasFocusRow, focusKey]);

  return (
    <table className="kv" aria-label={label}>
      <tbody>
        {all.map((r, i) => {
          const ghost = i === rows.length;
          const hl = !ghost && !!focusKey && r.key === focusKey;
          return (
            <tr key={i} className={ghost ? 'ghost' : hl ? 'hl' : undefined}>
              <td>
                {!ghost && (
                  <input type="checkbox" checked={r.enabled} title={r.enabled ? 'On' : 'Off (ignored)'} aria-label={`Enable ${r.key || 'row'}`} onChange={(e) => update(i, { enabled: e.target.checked })} />
                )}
              </td>
              <td>
                <input className="input" placeholder={keyPlaceholder} value={r.key} spellCheck={false} aria-label={`${label} key ${i + 1}`} onChange={(e) => update(i, { key: e.target.value })} />
              </td>
              <td>
                <input
                  className="input"
                  placeholder={valuePlaceholder}
                  value={r.value}
                  spellCheck={false}
                  ref={hl ? focusInput : undefined}
                  aria-label={`${label} value ${i + 1}`}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              </td>
              {extra && <td style={{ width: 30 }}>{!ghost && extra(r, i)}</td>}
              <td>
                {!ghost && (
                  <button className="icon-btn" title="Remove" aria-label={`Remove ${r.key || 'row'}`} onClick={() => remove(i)}>
                    ✕
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
