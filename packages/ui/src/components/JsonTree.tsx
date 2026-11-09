import { useMemo, type ReactNode } from 'react';
import { formatPath, type PathSegment } from '@restless/core';

interface Props {
  value: unknown;
  /** formatPath() of the picked value, to highlight it. */
  selected: string | null;
  onPick: (segments: PathSegment[], value: unknown) => void;
}

const MAX_NODES = 20_000;

function countNodes(v: unknown, limit: number): number {
  let n = 0;
  const stack: unknown[] = [v];
  while (stack.length && n <= limit) {
    const cur = stack.pop();
    n++;
    if (cur && typeof cur === 'object') stack.push(...(Array.isArray(cur) ? cur : Object.values(cur)));
  }
  return n;
}

export function canRenderTree(v: unknown) {
  return countNodes(v, MAX_NODES) <= MAX_NODES;
}

/** Pretty JSON where every value (and every key) is clickable, so it can be saved as a variable. */
export function JsonTree({ value, selected, onPick }: Props) {
  const nodes = useMemo(() => {
    const out: ReactNode[] = [];
    let k = 0;
    const pad = (n: number) => '  '.repeat(n);

    const leaf = (v: unknown, segs: PathSegment[]) => {
      const p = formatPath(segs);
      const cls = typeof v === 'string' ? 'j-str' : typeof v === 'number' ? 'j-num' : 'j-lit';
      out.push(
        <button key={k++} type="button" className={`jv-pick ${cls} ${selected === p ? 'sel' : ''}`} title={segs.length ? `Click to save ${p} as a variable` : 'Click to save as a variable'} onClick={() => onPick(segs, v)}>
          {JSON.stringify(v)}
        </button>,
      );
    };

    const walk = (v: unknown, segs: PathSegment[], depth: number) => {
      if (v === null || typeof v !== 'object') return leaf(v, segs);
      const isArr = Array.isArray(v);
      const entries: [PathSegment, unknown][] = isArr ? (v as unknown[]).map((x, i) => [i, x]) : Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) {
        out.push(isArr ? '[]' : '{}');
        return;
      }
      out.push(isArr ? '[\n' : '{\n');
      entries.forEach(([key, child], i) => {
        const childSegs = [...segs, key];
        out.push(pad(depth + 1));
        if (!isArr) {
          const p = formatPath(childSegs);
          out.push(
            <button key={k++} type="button" className={`jv-pick j-key ${selected === p ? 'sel' : ''}`} title={`Click to save ${p} as a variable`} onClick={() => onPick(childSegs, child)}>
              {JSON.stringify(key)}
            </button>,
            ': ',
          );
        }
        walk(child, childSegs, depth + 1);
        out.push(i < entries.length - 1 ? ',\n' : '\n');
      });
      out.push(pad(depth) + (isArr ? ']' : '}'));
    };
    walk(value, [], 0);
    return out;
  }, [value, selected, onPick]);

  return <pre className="code-view json-tree">{nodes}</pre>;
}
