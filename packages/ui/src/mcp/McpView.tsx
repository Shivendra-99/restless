import { useEffect, useMemo, useState } from 'react';
import {
  exampleFromSchema,
  lintTools,
  missingRequired,
  newId,
  shellSplit,
  type Bridge,
  type McpCallResult,
  type McpCatalog,
  type McpConnectInfo,
  type McpLogEntry,
  type McpServerConfig,
  type McpTool,
  type McpTransportKind,
} from '@restless/core';
import { KeyValueTable } from '../components/KeyValueTable';
import { SplitPane } from '../components/SplitPane';
import { SchemaForm } from './SchemaForm';
import { ToolResult } from './ToolResult';
import { McpLog } from './McpLog';
import { JsonView } from '../components/JsonView';
import { errorText, formatMs } from '../util';

interface Conn {
  status: 'connecting' | 'connected' | 'error' | 'closed';
  info?: McpConnectInfo;
  catalog?: McpCatalog;
  error?: string;
}

interface Props {
  bridge: Bridge;
  servers: McpServerConfig[];
  onServersChange: (servers: McpServerConfig[]) => void;
}

type Tab = 'tools' | 'resources' | 'prompts' | 'lint' | 'traffic';

const joinCommand = (cfg: McpServerConfig) =>
  [cfg.command ?? '', ...(cfg.args ?? [])].filter((x, i) => i > 0 || x).map((a) => (/[\s'"]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ');

export function newServer(bridge: Bridge): McpServerConfig {
  return bridge.capabilities.stdio
    ? { id: newId(), name: 'New server', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: [] }
    : { id: newId(), name: 'New server', transport: 'http', url: 'http://localhost:3333/mcp', headers: [] };
}

export function McpView({ bridge, servers, onServersChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(servers[0]?.id ?? null);
  const [conns, setConns] = useState<Record<string, Conn>>({});
  const [logs, setLogs] = useState<McpLogEntry[]>([]);
  const [tab, setTab] = useState<Tab>('tools');
  const [cmdText, setCmdText] = useState('');
  const [showExtra, setShowExtra] = useState(false);

  const cfg = servers.find((s) => s.id === selectedId) ?? null;
  const conn = cfg ? conns[cfg.id] : undefined;

  useEffect(() => bridge.mcp.onLog((e) => setLogs((prev) => (prev.length > 3000 ? [...prev.slice(-2500), e] : [...prev, e]))), [bridge]);
  useEffect(() => {
    if (cfg) setCmdText(joinCommand(cfg));
    // only when switching servers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.id]);

  const patch = (p: Partial<McpServerConfig>) => cfg && onServersChange(servers.map((s) => (s.id === cfg.id ? { ...s, ...p } : s)));
  const setConn = (id: string, c: Conn) => setConns((prev) => ({ ...prev, [id]: c }));

  const addServer = () => {
    const s = newServer(bridge);
    onServersChange([...servers, s]);
    setSelectedId(s.id);
  };

  const connect = async () => {
    if (!cfg) return;
    if (conn?.info) await bridge.mcp.disconnect(conn.info.sessionId).catch(() => {});
    setConn(cfg.id, { status: 'connecting' });
    try {
      const info = await bridge.mcp.connect(cfg);
      setConn(cfg.id, { status: 'connected', info });
      const catalog = await bridge.mcp.catalog(info.sessionId);
      setConn(cfg.id, { status: 'connected', info, catalog });
    } catch (e) {
      setConn(cfg.id, { status: 'error', error: errorText(e) });
      setTab('traffic');
    }
  };

  const disconnect = async () => {
    if (!cfg || !conn?.info) return;
    await bridge.mcp.disconnect(conn.info.sessionId).catch(() => {});
    setConn(cfg.id, { status: 'closed' });
  };

  const serverLogs = useMemo(() => (cfg ? logs.filter((l) => l.sessionId.startsWith(`${cfg.id}:`)) : []), [logs, cfg]);

  if (!cfg) {
    return (
      <div className="empty">
        <h2>Test an MCP server</h2>
        <p>
          Connect to a local server over stdio{bridge.capabilities.stdio ? '' : ' (desktop app)'} or a remote one over Streamable HTTP. Call its tools from a generated form, read resources, see every JSON-RPC message, and lint tool descriptions before an AI model ever sees them.
        </p>
        <button className="btn primary" onClick={addServer}>
          Add a server
        </button>
      </div>
    );
  }

  const transports: { id: McpTransportKind; label: string }[] = [
    { id: 'stdio', label: 'stdio' },
    { id: 'http', label: 'Streamable HTTP' },
    { id: 'sse', label: 'SSE (legacy)' },
  ];
  const busy = conn?.status === 'connecting';
  const connected = conn?.status === 'connected';

  return (
    <div className="mcp">
      <div className="conn-form">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="select" value={cfg.id} aria-label="Saved servers" onChange={(e) => setSelectedId(e.target.value)} style={{ minWidth: 200 }}>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="btn ghost small" onClick={addServer}>
            Add server
          </button>
          <button
            className="btn ghost small danger"
            onClick={() => {
              const rest = servers.filter((s) => s.id !== cfg.id);
              if (conn?.info) void bridge.mcp.disconnect(conn.info.sessionId);
              onServersChange(rest);
              setSelectedId(rest[0]?.id ?? null);
            }}
          >
            Remove
          </button>
          <span style={{ flex: 1 }} />
          <div className="seg" role="group" aria-label="Transport">
            {transports.map((t) => (
              <button
                key={t.id}
                aria-pressed={cfg.transport === t.id}
                disabled={t.id === 'stdio' && !bridge.capabilities.stdio}
                title={t.id === 'stdio' && !bridge.capabilities.stdio ? 'Local stdio servers need the desktop app; a browser cannot start processes' : undefined}
                onClick={() => patch({ transport: t.id })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="conn-row">
          <label className="field">
            Name
            <input className="input" value={cfg.name} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          {cfg.transport === 'stdio' ? (
            <label className="field">
              Command
              <input
                className="input mono"
                value={cmdText}
                spellCheck={false}
                placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents"
                onChange={(e) => {
                  setCmdText(e.target.value);
                  try {
                    const [command = '', ...args] = shellSplit(e.target.value);
                    patch({ command, args });
                  } catch {
                    /* unfinished quote; keep typing */
                  }
                }}
              />
            </label>
          ) : (
            <label className="field">
              Server URL
              <input className="input mono" value={cfg.url ?? ''} spellCheck={false} placeholder="https://example.com/mcp" onChange={(e) => patch({ url: e.target.value })} />
            </label>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {connected ? (
              <>
                <button className="btn" onClick={connect}>
                  Reconnect
                </button>
                <button className="btn ghost" onClick={disconnect}>
                  Disconnect
                </button>
              </>
            ) : (
              <button className="btn primary" onClick={connect} disabled={busy || (cfg.transport === 'stdio' ? !cfg.command : !cfg.url)}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            )}
          </div>
        </div>
        <div>
          <button className="btn ghost small" aria-expanded={showExtra} onClick={() => setShowExtra(!showExtra)}>
            {showExtra ? 'Hide' : 'Show'} {cfg.transport === 'stdio' ? 'environment variables' : 'headers'}
            {cfg.transport === 'stdio' ? ` (${cfg.env?.length ?? 0})` : ` (${cfg.headers?.length ?? 0})`}
          </button>
          {showExtra &&
            (cfg.transport === 'stdio' ? (
              <KeyValueTable label="Environment variables" keyPlaceholder="NAME" rows={cfg.env ?? []} onChange={(env) => patch({ env })} />
            ) : (
              <KeyValueTable label="Headers" keyPlaceholder="Authorization" rows={cfg.headers ?? []} onChange={(headers) => patch({ headers })} />
            ))}
        </div>
      </div>

      <div className="server-info" aria-live="polite">
        <span className={`dot ${connected ? 'on' : busy ? 'busy' : ''}`} />
        {connected && conn.info ? (
          <>
            <span>
              <b>{conn.info.serverInfo?.title ?? conn.info.serverInfo?.name ?? 'Unknown server'}</b> {conn.info.serverInfo?.version}
            </span>
            <span>Protocol {conn.info.protocolVersion ?? 'unknown'}</span>
            <span>Connected in {formatMs(conn.info.connectMs)}</span>
            {Object.keys(conn.info.capabilities).map((c) => (
              <span key={c} className="cap">
                {c}
              </span>
            ))}
            <PingButton bridge={bridge} sessionId={conn.info.sessionId} />
          </>
        ) : conn?.status === 'error' ? (
          <span style={{ color: 'var(--bad)' }}>Could not connect: {conn.error?.split('\n')[0]}</span>
        ) : busy ? (
          <span>Starting the handshake…</span>
        ) : (
          <span>Not connected</span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="tabs" role="tablist">
          {(
            [
              ['tools', 'Tools', conn?.catalog?.tools.length],
              ['resources', 'Resources', conn?.catalog ? conn.catalog.resources.length + conn.catalog.resourceTemplates.length : undefined],
              ['prompts', 'Prompts', conn?.catalog?.prompts.length],
              ['lint', 'Lint', conn?.catalog ? lintTools(conn.catalog.tools).issues.length : undefined],
              ['traffic', 'Traffic', serverLogs.length],
            ] as [Tab, string, number | undefined][]
          ).map(([id, label, n]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
              {n !== undefined && <span className="count">{n}</span>}
            </button>
          ))}
        </div>
        {conn?.status === 'error' && tab !== 'traffic' && (
          <div className="notice bad">
            <pre className="code-view" style={{ margin: 0 }}>{conn.error}</pre>
          </div>
        )}
        {conn?.catalog?.errors.map((e) => (
          <div key={e} className="notice warn">
            {e}
          </div>
        ))}
        {tab === 'traffic' ? (
          <McpLog entries={serverLogs} onClear={() => setLogs((prev) => prev.filter((l) => !l.sessionId.startsWith(`${cfg.id}:`)))} />
        ) : !connected || !conn.catalog || !conn.info ? (
          <div className="empty">{busy ? 'Connecting…' : 'Connect to see what this server offers.'}</div>
        ) : tab === 'tools' ? (
          <ToolsTab bridge={bridge} sessionId={conn.info.sessionId} tools={conn.catalog.tools} />
        ) : tab === 'resources' ? (
          <ResourcesTab bridge={bridge} sessionId={conn.info.sessionId} catalog={conn.catalog} />
        ) : tab === 'prompts' ? (
          <PromptsTab bridge={bridge} sessionId={conn.info.sessionId} catalog={conn.catalog} />
        ) : (
          <LintTab tools={conn.catalog.tools} />
        )}
      </div>
    </div>
  );
}

function PingButton({ bridge, sessionId }: { bridge: Bridge; sessionId: string }) {
  const [ms, setMs] = useState<string | null>(null);
  return (
    <button
      className="btn ghost small"
      onClick={async () => {
        try {
          setMs(formatMs(await bridge.mcp.ping(sessionId)));
        } catch (e) {
          setMs(`failed: ${errorText(e)}`);
        }
      }}
    >
      Ping{ms ? ` (${ms})` : ''}
    </button>
  );
}

function ToolsTab({ bridge, sessionId, tools }: { bridge: Bridge; sessionId: string; tools: McpTool[] }) {
  const [name, setName] = useState(tools[0]?.name ?? null);
  const [argsByTool, setArgsByTool] = useState<Record<string, Record<string, unknown>>>({});
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, { res: McpCallResult | null; error: string | null }>>({});
  const tool = tools.find((t) => t.name === name) ?? null;
  const args = (tool && argsByTool[tool.name]) ?? {};

  useEffect(() => {
    if (tool) setJsonText(JSON.stringify(argsByTool[tool.name] ?? exampleFromSchema(tool.inputSchema) ?? {}, null, 2));
    setJsonErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool?.name, mode]);

  if (tools.length === 0) return <div className="empty">This server has no tools.</div>;

  const run = async () => {
    if (!tool) return;
    let callArgs = args;
    if (mode === 'json') {
      try {
        callArgs = jsonText.trim() ? JSON.parse(jsonText) : {};
        setArgsByTool((p) => ({ ...p, [tool.name]: callArgs }));
      } catch (e) {
        setJsonErr(`Arguments are not valid JSON: ${errorText(e)}`);
        return;
      }
    }
    setRunning(true);
    try {
      const res = await bridge.mcp.callTool(sessionId, tool.name, callArgs);
      setResults((p) => ({ ...p, [tool.name]: { res, error: null } }));
    } catch (e) {
      setResults((p) => ({ ...p, [tool.name]: { res: null, error: errorText(e) } }));
    } finally {
      setRunning(false);
    }
  };

  const missing = tool && mode === 'form' ? missingRequired(tool.inputSchema, args) : [];
  const annotations = Object.entries(tool?.annotations ?? {}).filter(([k]) => k !== 'title');

  return (
    <SplitPane className="mcp-split" direction="columns" unit="px" defaultSize={240} minFirst={160} minSecond={320} storageKey="restless.split.mcp" label="Resize the list">
      <div className="mcp-list" role="listbox" aria-label="Tools">
        {tools.map((t) => (
          <div key={t.name} role="option" aria-selected={t.name === name} className={`mcp-item ${t.name === name ? 'active' : ''}`} onClick={() => setName(t.name)}>
            <div className="t">{t.name}</div>
            <div className="d">{t.description || 'No description'}</div>
          </div>
        ))}
      </div>
      {tool && (
        <div
          className="mcp-detail"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run();
          }}
        >
          <div>
            <h3>{tool.title ? `${tool.title} (${tool.name})` : tool.name}</h3>
            {annotations.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {annotations.map(([k, v]) => (
                  <span key={k} className="badge">
                    {k}: {String(v)}
                  </span>
                ))}
              </div>
            )}
          </div>
          <p className="desc">{tool.description || 'No description. Models choose tools mostly from this text, so this tool may never get called.'}</p>
          <div className="toolbar" style={{ margin: 0 }}>
            <div className="seg">
              <button aria-pressed={mode === 'form'} onClick={() => setMode('form')}>
                Form
              </button>
              <button aria-pressed={mode === 'json'} onClick={() => setMode('json')}>
                JSON
              </button>
            </div>
            <span style={{ flex: 1 }} />
            <button className="btn primary" onClick={run} disabled={running}>
              {running ? 'Running…' : 'Run tool'}
            </button>
          </div>
          {mode === 'form' ? (
            <SchemaForm key={tool.name} schema={tool.inputSchema} value={args} onChange={(v) => setArgsByTool((p) => ({ ...p, [tool.name]: v }))} />
          ) : (
            <textarea className="textarea" rows={8} spellCheck={false} aria-label="Arguments JSON" value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
          )}
          {jsonErr && <div className="notice bad" style={{ margin: 0 }}>{jsonErr}</div>}
          {missing.length > 0 && (
            <div className="notice warn" style={{ margin: 0 }}>
              Required but empty: {missing.join(', ')}. You can still run it to see how the server validates.
            </div>
          )}
          <ToolResult res={results[tool.name]?.res ?? null} error={results[tool.name]?.error ?? null} />
          <details>
            <summary style={{ cursor: 'pointer', color: 'var(--text-2)', fontSize: 13 }}>Input schema</summary>
            <JsonView text={JSON.stringify(tool.inputSchema, null, 2)} />
            {tool.outputSchema && (
              <>
                <p style={{ color: 'var(--text-2)', fontSize: 13 }}>Output schema</p>
                <JsonView text={JSON.stringify(tool.outputSchema, null, 2)} />
              </>
            )}
          </details>
        </div>
      )}
    </SplitPane>
  );
}

function ResourcesTab({ bridge, sessionId, catalog }: { bridge: Bridge; sessionId: string; catalog: McpCatalog }) {
  const [uri, setUri] = useState(catalog.resources[0]?.uri ?? catalog.resourceTemplates[0]?.uriTemplate ?? '');
  const [res, setRes] = useState<McpCallResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const read = async (u: string) => {
    setErr(null);
    try {
      setRes(await bridge.mcp.readResource(sessionId, u));
    } catch (e) {
      setRes(null);
      setErr(errorText(e));
    }
  };
  if (catalog.resources.length + catalog.resourceTemplates.length === 0) return <div className="empty">This server lists no resources.</div>;
  return (
    <SplitPane className="mcp-split" direction="columns" unit="px" defaultSize={240} minFirst={160} minSecond={320} storageKey="restless.split.mcp" label="Resize the list">
      <div className="mcp-list">
        {catalog.resources.map((r) => (
          <div key={r.uri} className={`mcp-item ${uri === r.uri ? 'active' : ''}`} onClick={() => (setUri(r.uri), void read(r.uri))}>
            <div className="t">{r.name}</div>
            <div className="d">{r.uri}</div>
          </div>
        ))}
        {catalog.resourceTemplates.map((r) => (
          <div key={r.uriTemplate} className={`mcp-item ${uri === r.uriTemplate ? 'active' : ''}`} onClick={() => setUri(r.uriTemplate)}>
            <div className="t">{r.name} (template)</div>
            <div className="d">{r.uriTemplate}</div>
          </div>
        ))}
      </div>
      <div className="mcp-detail">
        <form
          className="toolbar"
          style={{ margin: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            void read(uri);
          }}
        >
          <input className="input mono" style={{ flex: 1 }} value={uri} aria-label="Resource URI" onChange={(e) => setUri(e.target.value)} />
          <button className="btn primary" type="submit">
            Read
          </button>
        </form>
        {/\{[^}]+\}/.test(uri) && <p className="desc">Replace the {'{placeholders}'} in the template, then read it.</p>}
        <ToolResult res={res} error={err} />
      </div>
    </SplitPane>
  );
}

function PromptsTab({ bridge, sessionId, catalog }: { bridge: Bridge; sessionId: string; catalog: McpCatalog }) {
  const [name, setName] = useState(catalog.prompts[0]?.name ?? null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [res, setRes] = useState<McpCallResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const prompt = catalog.prompts.find((p) => p.name === name);
  if (catalog.prompts.length === 0) return <div className="empty">This server lists no prompts.</div>;
  return (
    <SplitPane className="mcp-split" direction="columns" unit="px" defaultSize={240} minFirst={160} minSecond={320} storageKey="restless.split.mcp" label="Resize the list">
      <div className="mcp-list">
        {catalog.prompts.map((p) => (
          <div key={p.name} className={`mcp-item ${p.name === name ? 'active' : ''}`} onClick={() => (setName(p.name), setRes(null), setErr(null))}>
            <div className="t">{p.name}</div>
            <div className="d">{p.description}</div>
          </div>
        ))}
      </div>
      {prompt && (
        <div className="mcp-detail">
          <h3>{prompt.name}</h3>
          {prompt.description && <p className="desc">{prompt.description}</p>}
          <div className="schema-form">
            {(prompt.arguments ?? []).map((a) => (
              <label key={a.name} className="field">
                <span className="mono" style={{ color: 'var(--text)' }}>
                  {a.name}
                  {a.required && <span className="req"> *</span>}
                </span>
                <textarea className="textarea" rows={2} value={args[a.name] ?? ''} onChange={(e) => setArgs({ ...args, [a.name]: e.target.value })} />
                {a.description && <span className="hint">{a.description}</span>}
              </label>
            ))}
          </div>
          <div>
            <button
              className="btn primary"
              onClick={async () => {
                setErr(null);
                try {
                  setRes(await bridge.mcp.getPrompt(sessionId, prompt.name, args));
                } catch (e) {
                  setRes(null);
                  setErr(errorText(e));
                }
              }}
            >
              Get prompt
            </button>
          </div>
          <ToolResult res={res} error={err} />
        </div>
      )}
    </SplitPane>
  );
}

function LintTab({ tools }: { tools: McpTool[] }) {
  const report = useMemo(() => lintTools(tools), [tools]);
  const max = Math.max(1, ...report.perTool.map((t) => t.approxTokens));
  return (
    <div className="mcp-detail" style={{ maxWidth: 900 }}>
      <p className="desc">
        The tool list costs roughly <b className="mono">{report.approxTokens.toLocaleString()}</b> tokens of model context on every request (estimated as characters ÷ 4).
      </p>
      <div>
        {report.perTool
          .slice()
          .sort((a, b) => b.approxTokens - a.approxTokens)
          .map((t) => (
            <div key={t.name} style={{ display: 'grid', gridTemplateColumns: '180px 1fr 60px', gap: 10, alignItems: 'center', padding: '3px 0' }}>
              <span className="mono" style={{ fontSize: 12.5 }}>
                {t.name}
              </span>
              <div className="token-bar" style={{ width: `${(t.approxTokens / max) * 100}%` }} />
              <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)', textAlign: 'right' }}>
                {t.approxTokens}
              </span>
            </div>
          ))}
      </div>
      {report.issues.length === 0 ? (
        <p className="desc">No problems found in tool names, descriptions or schemas.</p>
      ) : (
        <div>
          {report.issues.map((i, n) => (
            <div key={n} className="lint-row">
              <span className={`lvl-${i.level}`}>{i.level}</span>
              <span className="mono" style={{ fontSize: 12.5 }}>
                {i.tool}
              </span>
              <span>{i.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
