import { Fragment, useMemo } from 'react';

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const MAX_HIGHLIGHT = 300_000;

/** Pretty JSON with light syntax colors. Falls back to plain text for very large bodies. */
export function JsonView({ text }: { text: string }) {
  const parts = useMemo(() => {
    if (text.length > MAX_HIGHLIGHT) return null;
    const out: { t: string; c?: string }[] = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
      const i = m.index ?? 0;
      if (i > last) out.push({ t: text.slice(last, i) });
      if (m[1]) {
        out.push({ t: m[1], c: m[2] ? 'j-key' : 'j-str' });
        if (m[2]) out.push({ t: m[2] });
      } else if (m[3]) out.push({ t: m[3], c: 'j-lit' });
      else if (m[4]) out.push({ t: m[4], c: 'j-num' });
      last = i + m[0].length;
    }
    if (last < text.length) out.push({ t: text.slice(last) });
    return out;
  }, [text]);

  return (
    <pre className="code-view">
      {parts
        ? parts.map((p, i) => (p.c ? <span key={i} className={p.c}>{p.t}</span> : <Fragment key={i}>{p.t}</Fragment>))
        : text}
    </pre>
  );
}
