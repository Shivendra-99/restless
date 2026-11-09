import { useState } from 'react';
import { importPostmanCollection, importPostmanEnvironment, isPostmanCollection, parseCurl, type Environment, type RequestItem } from '@restless/core';
import { Dialog } from './Dialog';
import { errorText } from '../util';

interface Props {
  onImport: (requests: RequestItem[], environments: Environment[], summary: string) => void;
  onClose: () => void;
}

export function ImportDialog({ onImport, onClose }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const run = (input: string, fileName?: string) => {
    setError(null);
    setWarnings([]);
    const t = input.trim();
    if (!t) {
      setError('Paste a cURL command or a Postman JSON export first.');
      return;
    }
    try {
      if (/^curl\s/.test(t)) {
        const { request, warnings } = parseCurl(t);
        setWarnings(warnings);
        onImport([request], [], `Imported ${request.name}`);
        return;
      }
      const json = JSON.parse(t);
      if (isPostmanCollection(json)) {
        const res = importPostmanCollection(json);
        setWarnings(res.warnings);
        onImport(res.requests, res.environment ? [res.environment] : [], `Imported ${res.requests.length} requests from ${res.name}${res.warnings.length ? ` (${res.warnings.length} warnings)` : ''}`);
        return;
      }
      if (Array.isArray(json?.values)) {
        const env = importPostmanEnvironment(json);
        onImport([], [env], `Imported environment ${env.name}`);
        return;
      }
      setError(`${fileName ?? 'This'} doesn't look like a cURL command, a Postman collection (v2.x) or a Postman environment.`);
    } catch (e) {
      setError(`Could not import: ${errorText(e)}`);
    }
  };

  return (
    <Dialog
      title="Import"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => run(text)}>
            Import
          </button>
        </>
      }
    >
      <label className="field">
        Paste a cURL command, a Postman collection or a Postman environment
        <textarea className="textarea" rows={10} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={"curl 'https://api.example.com/users' -H 'accept: application/json'"} />
      </label>
      <label className="field">
        Or choose an exported file (.json)
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const content = await f.text();
            setText(content.length > 20000 ? `${content.slice(0, 20000)}\n…` : content);
            run(content, f.name);
          }}
        />
        <span className="hint">In Postman: collection menu, Export, Collection v2.1. Nothing is uploaded anywhere.</span>
      </label>
      {error && <div className="notice bad" style={{ margin: 0 }}>{error}</div>}
      {warnings.length > 0 && (
        <ul className="warn-list">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
