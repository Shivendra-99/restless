import { useState } from 'react';
import { describeCapture, newId, type Environment, type EnvVar, type Workspace } from '@restless/core';
import { Dialog } from './Dialog';
import { KeyValueTable } from './KeyValueTable';

export type VariablesTarget = { scope: 'global'; focus?: string } | { scope: 'environment'; id: string; focus?: string };

interface Props {
  ws: Workspace;
  update: (fn: (w: Workspace) => Workspace) => void;
  initial: VariablesTarget;
  onOpenRequest: (id: string) => void;
  onClose: () => void;
}

function LocalToggle({ row, onToggle }: { row: EnvVar; onToggle: () => void }) {
  return (
    <button
      className="icon-btn lock"
      aria-pressed={!!row.secret}
      title={row.secret ? 'Kept only on this computer (not written to the workspace folder). Click to share it in the workspace.' : 'Saved in the workspace folder. Click to keep it only on this computer.'}
      aria-label={`Keep ${row.key} only on this computer`}
      onClick={onToggle}
    >
      {row.secret ? '🔒' : '🔓'}
    </button>
  );
}

/** One place for every variable: globals first, then environments. */
export function VariablesDialog({ ws, update, initial, onOpenRequest, onClose }: Props) {
  const [sel, setSel] = useState<VariablesTarget>(initial);
  const env = sel.scope === 'environment' ? ws.environments.find((e) => e.id === sel.id) ?? null : null;

  const setGlobals = (globals: EnvVar[]) => update((w) => ({ ...w, globals }));
  const setEnv = (e: Environment) => update((w) => ({ ...w, environments: w.environments.map((x) => (x.id === e.id ? e : x)) }));
  const addEnv = () => {
    const e: Environment = { id: newId(), name: `Environment ${ws.environments.length + 1}`, variables: [{ key: 'baseUrl', value: 'http://localhost:3000', enabled: true }] };
    update((w) => ({ ...w, environments: [...w.environments, e], activeEnvironmentId: w.activeEnvironmentId ?? e.id }));
    setSel({ scope: 'environment', id: e.id });
  };

  const autoUpdated = ws.requests.flatMap((r) => (r.captures ?? []).map((c) => ({ r, c })));

  return (
    <Dialog title="Variables" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="env-layout">
        <nav className="env-list" aria-label="Variable sets">
          <button aria-pressed={sel.scope === 'global'} onClick={() => setSel({ scope: 'global' })}>
            Global
            <span className="sub">Every request</span>
          </button>
          <div className="env-list-label">Environments</div>
          {ws.environments.map((e) => (
            <button key={e.id} aria-pressed={sel.scope === 'environment' && sel.id === e.id} onClick={() => setSel({ scope: 'environment', id: e.id })}>
              {e.name}
              {ws.activeEnvironmentId === e.id && <span className="sub">In use</span>}
            </button>
          ))}
          <button onClick={addEnv} className="add-env">
            + Add environment
          </button>
        </nav>

        <div className="var-panel">
          {sel.scope === 'global' ? (
            <>
              <p className="var-help">
                Use any of these in a URL, header, body or auth as <code>{'{{name}}'}</code>. To save a value from a response, send the request and click the value.
              </p>
              <KeyValueTable label="Global variables" keyPlaceholder="Name" rows={ws.globals} onChange={setGlobals} focusKey={sel.focus} extra={(row, i) => <LocalToggle row={row} onToggle={() => setGlobals(ws.globals.map((g, j) => (j === i ? { ...g, secret: !g.secret } : g)))} />} />
              {autoUpdated.length > 0 && (
                <div className="auto-list">
                  <h3>Updated automatically</h3>
                  {autoUpdated.map(({ r, c }) => (
                    <div key={c.id} className="auto-row">
                      <code>{`{{${c.variable}}}`}</code>
                      <span>
                        from {describeCapture(c)} of{' '}
                        <button
                          className="link"
                          onClick={() => {
                            onOpenRequest(r.id);
                            onClose();
                          }}
                        >
                          {r.name}
                        </button>
                        , each time it is sent
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : env ? (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" style={{ flex: 1 }} value={env.name} aria-label="Environment name" onChange={(e) => setEnv({ ...env, name: e.target.value })} />
                {ws.activeEnvironmentId !== env.id && (
                  <button className="btn ghost" onClick={() => update((w) => ({ ...w, activeEnvironmentId: env.id }))}>
                    Use this
                  </button>
                )}
                <button
                  className="btn ghost danger"
                  onClick={() => {
                    if (!window.confirm(`Delete the environment "${env.name}"?`)) return;
                    update((w) => ({
                      ...w,
                      environments: w.environments.filter((x) => x.id !== env.id),
                      activeEnvironmentId: w.activeEnvironmentId === env.id ? null : w.activeEnvironmentId,
                    }));
                    setSel({ scope: 'global' });
                  }}
                >
                  Delete
                </button>
              </div>
              <p className="var-help">
                Environments hold values that change between setups, like the base URL for local, staging and production. When this environment is in use, its values win over globals with the same name.
              </p>
              <KeyValueTable label="Environment variables" keyPlaceholder="Name" rows={env.variables} onChange={(variables) => setEnv({ ...env, variables })} focusKey={sel.focus} extra={(row, i) => <LocalToggle row={row} onToggle={() => setEnv({ ...env, variables: env.variables.map((v, j) => (j === i ? { ...v, secret: !v.secret } : v)) })} />} />
            </>
          ) : (
            <p className="var-help">This environment was deleted.</p>
          )}
          <p className="var-foot">🔒 values stay only on this computer; 🔓 values are saved in the workspace folder and can be shared through git.</p>
        </div>
      </div>
    </Dialog>
  );
}
