import { useState } from 'react';
import { newId, type Environment } from '@probe/core';
import { Dialog } from './Dialog';
import { KeyValueTable } from './KeyValueTable';

interface Props {
  environments: Environment[];
  activeId: string | null;
  onChange: (envs: Environment[]) => void;
  onClose: () => void;
}

export function EnvEditor({ environments, activeId, onChange, onClose }: Props) {
  const [selected, setSelected] = useState<string | null>(activeId ?? environments[0]?.id ?? null);
  const env = environments.find((e) => e.id === selected) ?? null;
  const patch = (e: Environment) => onChange(environments.map((x) => (x.id === e.id ? e : x)));

  const add = () => {
    const e: Environment = { id: newId(), name: `Environment ${environments.length + 1}`, variables: [{ key: 'baseUrl', value: 'http://localhost:3000', enabled: true }] };
    onChange([...environments, e]);
    setSelected(e.id);
  };

  return (
    <Dialog title="Environments" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="env-layout">
        <div className="env-list">
          {environments.map((e) => (
            <button key={e.id} aria-pressed={e.id === selected} onClick={() => setSelected(e.id)}>
              {e.name}
            </button>
          ))}
          <button onClick={add} style={{ color: 'var(--signal)' }}>
            + Add environment
          </button>
        </div>
        <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          {env ? (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" style={{ flex: 1 }} value={env.name} aria-label="Environment name" onChange={(e) => patch({ ...env, name: e.target.value })} />
                <button
                  className="btn ghost danger"
                  onClick={() => {
                    onChange(environments.filter((x) => x.id !== env.id));
                    setSelected(environments.find((x) => x.id !== env.id)?.id ?? null);
                  }}
                >
                  Delete
                </button>
              </div>
              <KeyValueTable
                label="Variables"
                keyPlaceholder="Variable"
                rows={env.variables}
                onChange={(rows) => patch({ ...env, variables: rows.map((r, i) => ({ ...r, secret: env.variables[i]?.secret })) })}
                extra={(row, i) => (
                  <button
                    className="icon-btn lock"
                    aria-pressed={!!env.variables[i]?.secret}
                    title={env.variables[i]?.secret ? 'Secret: kept out of workspace files' : 'Mark as secret'}
                    aria-label={`Secret ${row.key}`}
                    onClick={() => patch({ ...env, variables: env.variables.map((v, j) => (j === i ? { ...v, secret: !v.secret } : v)) })}
                  >
                    {env.variables[i]?.secret ? '🔒' : '🔓'}
                  </button>
                )}
              />
              <p style={{ margin: 0, color: 'var(--text-3)', fontSize: 13 }}>
                Use a variable as {'{{name}}'} in URLs, headers, bodies and auth. Secret values are stored encrypted on this machine and never written to the workspace folder, so the folder is safe to commit to git.
              </p>
            </>
          ) : (
            <div className="empty" style={{ padding: 0 }}>
              <h2>No environments</h2>
              <p>Environments hold values like base URLs and tokens, so one request works against local, staging and production.</p>
              <button className="btn primary" onClick={add}>
                Add environment
              </button>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
