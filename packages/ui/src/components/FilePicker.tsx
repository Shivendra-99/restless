import { useRef } from 'react';
import { guessContentType, newId, recallFile, rememberFile, type Bridge, type FileRef, type FormField } from '@restless/core';
import { formatBytes } from '../util';

/** Desktop: the system file dialog, and only the path is kept. Browser: a file input, and the file stays in memory. */
export function useFilePicker(bridge: Bridge, onPick: (file: FileRef) => void) {
  const input = useRef<HTMLInputElement>(null);
  const target = useRef(onPick);
  target.current = onPick;
  const open = async () => {
    if (bridge.pickUpload) {
      const f = await bridge.pickUpload();
      if (f) target.current(f);
    } else input.current?.click();
  };
  const element = bridge.pickUpload ? null : (
    <input
      ref={input}
      type="file"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        const id = newId();
        rememberFile(id, f);
        target.current({ id, name: f.name, size: f.size, contentType: f.type || guessContentType(f.name) });
      }}
    />
  );
  return { open, element };
}

/** A picked file that can no longer be sent: the extension lost it on reload. */
export const fileIsGone = (f: FileRef) => !f.path && !recallFile(f.id);

function FileButton({ file, onOpen, label }: { file: FileRef | null | undefined; onOpen: () => void; label: string }) {
  const gone = !!file && fileIsGone(file);
  return (
    <button type="button" className={`file-btn ${gone ? 'gone' : ''}`} onClick={onOpen} aria-label={file ? `${label}: ${file.name}. Choose another file` : `${label}: choose a file`} title={file?.path ?? file?.name}>
      {file ? (
        <>
          <span className="file-name">{file.name}</span>
          <span className="file-meta">{gone ? 'choose again' : file.size !== undefined ? formatBytes(file.size) : ''}</span>
        </>
      ) : (
        <span className="file-meta">Choose a file…</span>
      )}
    </button>
  );
}

/** One file sent as the whole request body. */
export function FileBody({ bridge, file, onChange }: { bridge: Bridge; file: FileRef | null | undefined; onChange: (file: FileRef | null) => void }) {
  const picker = useFilePicker(bridge, onChange);
  return (
    <div className="file-body">
      {picker.element}
      <div className="file-row">
        <FileButton file={file} onOpen={() => void picker.open()} label="File to send" />
        {file && (
          <button className="icon-btn" title="Remove the file" aria-label="Remove the file" onClick={() => onChange(null)}>
            ✕
          </button>
        )}
      </div>
      {file && (
        <label className="field">
          Content type
          <input className="input mono" value={file.contentType ?? ''} placeholder="application/octet-stream" spellCheck={false} onChange={(e) => onChange({ ...file, contentType: e.target.value })} />
          <span className="hint">Sent as the Content-Type header, unless the Headers tab sets one.</span>
        </label>
      )}
      <p className="hint-line">{file?.path ? `Read from ${file.path} each time you send.` : bridge.pickUpload ? 'The file is read from your disk each time you send, so edits to it are picked up.' : 'The file stays in this tab only. After a reload you choose it again.'}</p>
    </div>
  );
}

/** multipart/form-data fields: each is text or a file. */
export function MultipartTable({ bridge, rows, onChange }: { bridge: Bridge; rows: FormField[]; onChange: (rows: FormField[]) => void }) {
  const picking = useRef(-1);
  const picker = useFilePicker(bridge, (file) => {
    const i = picking.current;
    if (i >= 0 && i < rows.length) onChange(rows.map((r, j) => (j === i ? { ...r, file } : r)));
  });
  const update = (i: number, patch: Partial<FormField>) => {
    if (i === rows.length) onChange([...rows, { key: '', value: '', enabled: true, ...patch }]);
    else onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const all: FormField[] = [...rows, { key: '', value: '', enabled: true }];
  return (
    <>
      {picker.element}
      <table className="kv multipart" aria-label="Form fields">
        <tbody>
          {all.map((r, i) => {
            const ghost = i === rows.length;
            const isFile = r.file !== undefined;
            return (
              <tr key={i} className={ghost ? 'ghost' : undefined}>
                <td>{!ghost && <input type="checkbox" checked={r.enabled} title={r.enabled ? 'On' : 'Off (ignored)'} aria-label={`Enable ${r.key || 'field'}`} onChange={(e) => update(i, { enabled: e.target.checked })} />}</td>
                <td>
                  <input className="input" placeholder="Field name" value={r.key} spellCheck={false} aria-label={`Field name ${i + 1}`} onChange={(e) => update(i, { key: e.target.value })} />
                </td>
                <td className="kind">
                  <select
                    className="select"
                    aria-label={`Field ${i + 1} holds`}
                    value={isFile ? 'file' : 'text'}
                    onChange={(e) => {
                      if (e.target.value === 'file') update(i, { file: r.file ?? null, value: '' });
                      else if (ghost) update(i, {});
                      else onChange(rows.map((x, j) => (j === i ? { key: x.key, value: x.value, enabled: x.enabled } : x)));
                    }}
                  >
                    <option value="text">Text</option>
                    <option value="file">File</option>
                  </select>
                </td>
                <td>
                  {isFile ? (
                    <FileButton
                      file={r.file}
                      label={`File for ${r.key || 'this field'}`}
                      onOpen={() => {
                        picking.current = i;
                        void picker.open();
                      }}
                    />
                  ) : (
                    <input className="input" placeholder="Value" value={r.value} spellCheck={false} aria-label={`Field value ${i + 1}`} onChange={(e) => update(i, { value: e.target.value })} />
                  )}
                </td>
                <td>
                  {!ghost && (
                    <button className="icon-btn" title="Remove" aria-label={`Remove ${r.key || 'field'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
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
