// Bulk editing of key/value lists (params, headers, form fields).
// Reads whatever people usually have on the clipboard: `key: value` lines, JSON, XML, a query string or a whole URL.
import type { KeyValue } from './types';

export type PairFormat = 'lines' | 'json' | 'xml' | 'query';

export interface ParsedPairs {
  rows: KeyValue[];
  format: PairFormat;
}

const row = (key: string, value: string, enabled = true): KeyValue => ({ key, value, enabled });

// ---------------------------------------------------------------- JSON

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Nested objects become `a.b`, lists of plain values repeat the key (`id=1&id=2`), lists of objects become `a[0].b`. */
function flatten(value: unknown, prefix: string, out: KeyValue[]) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => (isPlain(v) || Array.isArray(v) ? flatten(v, `${prefix}[${i}]`, out) : out.push(row(prefix, text(v)))));
  } else if (isPlain(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.push(row(prefix, text(value)));
}

function fromJson(json: unknown): KeyValue[] | null {
  // A list of { key | name, value } objects, as Postman, HAR files and browser dev tools write them.
  if (Array.isArray(json) && json.length && json.every((x) => isPlain(x) && ('key' in x || 'name' in x))) {
    return (json as Record<string, unknown>[]).map((x) => row(text(x.key ?? x.name), text(x.value), x.disabled !== true && x.enabled !== false));
  }
  if (!isPlain(json)) return null;
  const out: KeyValue[] = [];
  flatten(json, '', out);
  return out;
}

// ---------------------------------------------------------------- XML

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? whole;
  });

/** A small XML reader: elements, attributes, text and CDATA. Enough for lists of settings, not for documents. */
function parseXml(input: string): XmlNode | null {
  const src = input.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root: XmlNode = { tag: '', attrs: {}, children: [], text: '' };
  const stack = [root];
  for (let m = token.exec(src); m; m = token.exec(src)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length < 2 || top.tag !== m[2]) return null;
      stack.pop();
    } else if (m[3] !== undefined) {
      const node: XmlNode = { tag: m[3], attrs: {}, children: [], text: '' };
      for (const a of m[4].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return stack.length === 1 && root.children.length === 1 && !root.text.trim() ? root.children[0] : null;
}

function xmlRows(node: XmlNode, prefix: string, out: KeyValue[]) {
  for (const c of node.children) {
    // <param name="page" value="2"/> or <entry key="page">2</entry>
    const named = c.attrs.name ?? c.attrs.key;
    if (named !== undefined && c.children.length === 0) {
      out.push(row(prefix ? `${prefix}.${named}` : named, c.attrs.value ?? c.text.trim(), c.attrs.enabled !== 'false' && c.attrs.disabled !== 'true'));
      continue;
    }
    const key = prefix ? `${prefix}.${c.tag}` : c.tag;
    if (c.children.length) xmlRows(c, key, out);
    else out.push(row(key, c.text.trim()));
  }
}

// ---------------------------------------------------------------- query string and lines

const unescape = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

function fromQuery(input: string): KeyValue[] {
  const hash = input.indexOf('#');
  const q = (hash >= 0 ? input.slice(0, hash) : input).replace(/^[^?]*\?/, '');
  return q
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return row(unescape(eq >= 0 ? pair.slice(0, eq) : pair), unescape(eq >= 0 ? pair.slice(eq + 1) : ''));
    });
}

const unquote = (s: string) => (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) ? s.slice(1, -1) : s);

/** `key: value`, `key=value` or key<TAB>value, one per line. A line starting with # or // is kept but switched off. */
function fromLines(input: string): KeyValue[] {
  const out: KeyValue[] = [];
  for (const raw of input.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const off = /^(#|\/\/)/.test(line);
    if (off) line = line.replace(/^(#|\/\/)\s*/, '');
    if (!line) continue;
    const idx = line.search(/[:=\t]/);
    const key = unquote((idx >= 0 ? line.slice(0, idx) : line).trim());
    const value = unquote((idx >= 0 ? line.slice(idx + 1) : '').trim().replace(/,$/, '').trim());
    if (key) out.push(row(key, value, !off));
  }
  return out;
}

/** Read pasted or typed text as key/value rows, working out the format from how it starts. */
export function parsePairs(input: string): ParsedPairs {
  const t = input.trim();
  if (!t) return { rows: [], format: 'lines' };
  if (t[0] === '{' || t[0] === '[') {
    try {
      const rows = fromJson(JSON.parse(t));
      if (rows) return { rows, format: 'json' };
    } catch {
      /* not JSON after all: read it as lines */
    }
  }
  if (t[0] === '<') {
    const root = parseXml(t);
    if (root) {
      const rows: KeyValue[] = [];
      xmlRows(root, '', rows);
      if (rows.length) return { rows, format: 'xml' };
    }
  }
  const oneLine = !/[\r\n]/.test(t);
  if (oneLine && (/^(https?:\/\/[^\s?]*)?\?/i.test(t) || (/^[^\s:=&]+=[^\s]*&[^\s]+$/.test(t) && !t.includes(': ')))) return { rows: fromQuery(t), format: 'query' };
  return { rows: fromLines(t), format: 'lines' };
}

/** Rows as editable text: one `key: value` per line, switched-off rows behind a `# `. */
export function formatPairs(rows: KeyValue[]): string {
  return rows
    .filter((r) => r.key || r.value)
    .map((r) => `${r.enabled ? '' : '# '}${r.key}: ${r.value}`)
    .join('\n');
}

/** True when pasted text is clearly several rows (or a structured format), so a paste into one cell should fill the table. */
export function looksLikeManyPairs(input: string): boolean {
  const t = input.trim();
  if (!t) return false;
  const { rows, format } = parsePairs(t);
  if (format === 'lines') return rows.length > 1 && /[\r\n]/.test(t);
  return rows.length > 0;
}
