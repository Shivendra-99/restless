import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { formatPairs, looksLikeManyPairs, parsePairs, type KeyValue, type PairFormat } from '@restless/core';

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
  /** Offer "Bulk edit": the whole list as text, which also reads pasted JSON, XML and query strings. */
  bulk?: boolean;
  /** What one row is called, for messages ("param", "header", "field"). */
  noun?: string;
}

const FORMAT_NAME: Record<PairFormat, string> = { lines: 'key: value lines', json: 'JSON', xml: 'XML', query: 'query string' };
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The list as text. Nothing changes until "Apply". */
function BulkEditor<T extends KeyValue>({ rows, onApply, onClose, label, noun }: { rows: T[]; onApply: (rows: KeyValue[]) => void; onClose: () => void; label: string; noun: string }) {
  const [text, setText] = useState(() => formatPairs(rows));
  const parsed = useMemo(() => parsePairs(text), [text]);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  return (
    <div className="bulk">
      <textarea
        ref={area}
        className="textarea"
        rows={9}
        spellCheck={false}
        aria-label={`${label}, as text`}
        value={text}
        placeholder={'page: 1\nlimit: 20\n# sort: name   (a line starting with # is kept, switched off)\n\nOr paste JSON, XML, a query string or a whole URL.'}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="bulk-foot">
        <span className="bulk-status" aria-live="polite">
          {text.trim() === '' ? `Empty: applying removes every ${noun}.` : `Reads as ${plural(parsed.rows.length, noun)}${parsed.format === 'lines' ? '' : `, from ${parsed.format === 'query' ? 'a ' : ''}${FORMAT_NAME[parsed.format]}`}.`}
        </span>
        <button className="btn small" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary small"
          onClick={() => {
            onApply(parsed.rows);
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

/** Editable key/value list with a trailing blank row that turns into a real row as you type. Extra fields on rows are kept. */
export function KeyValueTable<T extends KeyValue>({ rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', extra, label, focusKey, bulk, noun = 'row' }: Props<T>) {
  const [bulkOpen, setBulkOpen] = useState(false);
  const [pasted, setPasted] = useState('');
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

  // Pasting several rows at once (or JSON, XML, a query string) into a key fills the table instead of one cell.
  const onPaste = (e: ClipboardEvent<HTMLInputElement>, i: number) => {
    if (!bulk) return;
    const text = e.clipboardData.getData('text');
    if (!looksLikeManyPairs(text)) return;
    e.preventDefault();
    const { rows: incoming, format } = parsePairs(text);
    // Pasted into an untouched row: that row is replaced. Otherwise the new rows go at the end.
    const keep = i < rows.length && !rows[i].key && !rows[i].value ? rows.filter((_, j) => j !== i) : rows;
    onChange([...keep, ...(incoming as T[])]);
    setPasted(`Added ${plural(incoming.length, noun)} from the pasted ${format === 'lines' ? 'lines' : FORMAT_NAME[format]}.`);
  };

  if (bulk && bulkOpen) return <BulkEditor rows={rows} label={label} noun={noun} onApply={(next) => onChange(next as T[])} onClose={() => setBulkOpen(false)} />;

  return (
    <>
    {bulk && (
      <div className="kv-tools">
        <span className="kv-note" aria-live="polite">{pasted}</span>
        <button
          className="btn ghost small"
          title="Edit the whole list as text, or paste JSON, XML or a query string"
          onClick={() => {
            setPasted('');
            setBulkOpen(true);
          }}
        >
          Bulk edit
        </button>
      </div>
    )}
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
                <input className="input" placeholder={keyPlaceholder} value={r.key} spellCheck={false} aria-label={`${label} key ${i + 1}`} onPaste={(e) => onPaste(e, i)} onChange={(e) => update(i, { key: e.target.value })} />
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
    </>
  );
}
