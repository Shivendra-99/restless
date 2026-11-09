import type { ReactNode } from 'react';
import type { KeyValue } from '@probe/core';

interface Props {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Optional extra control per row (e.g. the secret toggle for environments). */
  extra?: (row: KeyValue, index: number) => ReactNode;
  label: string;
}

/** Editable key/value list with a trailing blank row that turns into a real row as you type. */
export function KeyValueTable({ rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', extra, label }: Props) {
  const update = (i: number, patch: Partial<KeyValue>) => {
    if (i === rows.length) onChange([...rows, { key: '', value: '', enabled: true, ...patch }]);
    else onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const all = [...rows, { key: '', value: '', enabled: true }];

  return (
    <table className="kv" aria-label={label}>
      <tbody>
        {all.map((r, i) => {
          const ghost = i === rows.length;
          return (
            <tr key={i} className={ghost ? 'ghost' : undefined}>
              <td>
                {!ghost && (
                  <input type="checkbox" checked={r.enabled} aria-label={`Enable ${r.key || 'row'}`} onChange={(e) => update(i, { enabled: e.target.checked })} />
                )}
              </td>
              <td>
                <input className="input" placeholder={keyPlaceholder} value={r.key} aria-label={`${label} key ${i + 1}`} onChange={(e) => update(i, { key: e.target.value })} />
              </td>
              <td>
                <input className="input" placeholder={valuePlaceholder} value={r.value} aria-label={`${label} value ${i + 1}`} onChange={(e) => update(i, { value: e.target.value })} />
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
