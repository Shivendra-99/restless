import { useState } from 'react';
import type { McpCallResult } from '@probe/core';
import { JsonView } from '../components/JsonView';
import { formatMs, tryPrettyJson } from '../util';

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
  uri?: string;
  name?: string;
}

function Block({ b }: { b: ContentBlock }) {
  if (b.type === 'text') {
    const pretty = b.text ? tryPrettyJson(b.text) : null;
    return pretty ? <JsonView text={pretty} /> : <pre className="code-view">{b.text}</pre>;
  }
  if (b.type === 'image' && b.data) return <img alt="Tool image output" src={`data:${b.mimeType ?? 'image/png'};base64,${b.data}`} />;
  if (b.type === 'audio' && b.data) return <audio controls src={`data:${b.mimeType ?? 'audio/wav'};base64,${b.data}`} />;
  return <JsonView text={JSON.stringify(b, null, 2)} />;
}

/** Renders tools/call, resources/read and prompts/get results. */
export function ToolResult({ res, error }: { res: McpCallResult | null; error: string | null }) {
  const [raw, setRaw] = useState(false);
  if (error) {
    return (
      <div className="result err" role="alert">
        <div className="result-head">
          <span className="badge bad">Request failed</span>
        </div>
        <div className="result-body">
          <pre className="code-view">{error}</pre>
        </div>
      </div>
    );
  }
  if (!res) return null;
  const r = res.result as { content?: ContentBlock[]; structuredContent?: unknown; contents?: ContentBlock[]; messages?: { role: string; content: ContentBlock }[] };
  return (
    <div className={`result ${res.isError ? 'err' : ''}`}>
      <div className="result-head">
        <span className={`badge ${res.isError ? 'bad' : 'ok'}`}>{res.isError ? 'Tool returned an error' : 'OK'}</span>
        <span>{formatMs(res.durationMs)}</span>
        <span style={{ flex: 1 }} />
        <div className="seg">
          <button aria-pressed={!raw} onClick={() => setRaw(false)}>
            Rendered
          </button>
          <button aria-pressed={raw} onClick={() => setRaw(true)}>
            Raw JSON
          </button>
        </div>
      </div>
      <div className="result-body">
        {raw ? (
          <JsonView text={JSON.stringify(res.result, null, 2)} />
        ) : (
          <>
            {r.content?.map((b, i) => <Block key={i} b={b} />)}
            {r.contents?.map((b, i) => <Block key={i} b={b.text !== undefined ? { type: 'text', text: b.text } : b} />)}
            {r.messages?.map((m, i) => (
              <div key={i}>
                <span className="badge">{m.role}</span>
                <Block b={m.content} />
              </div>
            ))}
            {r.structuredContent !== undefined && (
              <div>
                <span className="badge">structuredContent</span>
                <JsonView text={JSON.stringify(r.structuredContent, null, 2)} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
