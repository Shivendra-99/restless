import { useState } from 'react';
import {
  importPostmanCollection,
  importPostmanEnvironment,
  importPostmanGlobals,
  isPostmanCollection,
  isPostmanGlobals,
  parseCurl,
  type Collection,
  type Environment,
  type EnvVar,
  type RequestItem,
} from '@restless/core';
import { Dialog } from './Dialog';
import { errorText } from '../util';

export interface ImportResult {
  /** A new collection to add (Postman collection). Without one, requests go into the current collection. */
  collection?: Collection;
  requests: RequestItem[];
  environments: Environment[];
  globals: EnvVar[];
  summary: string;
}

interface Props {
  onImport: (result: ImportResult) => void;
  onClose: () => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ImportDialog({ onImport, onClose }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);

  const finish = (result: ImportResult, warns: string[]) => {
    onImport(result);
    if (warns.length) {
      // Keep the dialog open so the notes can be read.
      setWarnings(warns);
      setDone(result.summary);
    } else onClose();
  };

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
        finish({ requests: [request], environments: [], globals: [], summary: `Imported ${request.name}` }, warnings);
        return;
      }
      const json = JSON.parse(t);
      if (isPostmanCollection(json)) {
        const res = importPostmanCollection(json);
        const saved = res.requests.reduce((n, r) => n + (r.captures?.length ?? 0), 0);
        finish(
          {
            collection: res.collection,
            requests: res.requests,
            environments: res.environment ? [res.environment] : [],
            globals: [],
            summary: `Imported the collection ${res.collection.name} with ${plural(res.requests.length, 'request')}${saved ? `; ${plural(saved, 'value')} will be saved to variables automatically` : ''}`,
          },
          res.warnings,
        );
        return;
      }
      if (isPostmanGlobals(json)) {
        const globals = importPostmanGlobals(json);
        finish({ requests: [], environments: [], globals, summary: `Imported ${plural(globals.length, 'global variable')}` }, []);
        return;
      }
      if (Array.isArray(json?.values)) {
        const env = importPostmanEnvironment(json);
        finish({ requests: [], environments: [env], globals: [], summary: `Imported the environment ${env.name}` }, []);
        return;
      }
      setError(`${fileName ?? 'This'} doesn't look like a cURL command, a Postman collection (v2.x), Postman globals or a Postman environment.`);
    } catch (e) {
      setError(`Could not import: ${errorText(e)}`);
    }
  };

  if (done) {
    return (
      <Dialog title="Imported" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <p style={{ margin: 0 }}>{done}.</p>
        <p style={{ margin: 0, color: 'var(--text-2)' }}>A few things could not be brought over:</p>
        <ul className="warn-list">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      </Dialog>
    );
  }

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
        Paste a cURL command, or a Postman collection, environment or globals export
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
