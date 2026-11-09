import { HTTP_METHODS, newRequest, type HttpMethod, type KeyValue, type RequestItem, type ResolvedRequest } from './types';

/** Split a shell command into argv, handling quotes, escapes and line continuations. */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  const s = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting: $'...'
      i++;
      quote = "'";
      inToken = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      inToken = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
      continue;
    }
    cur += c;
    inToken = true;
  }
  if (quote) throw new Error('Unterminated quote in cURL command');
  if (inToken) out.push(cur);
  return out;
}

const TAKES_VALUE = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii',
  '--data-urlencode', '-u', '--user', '--url', '-b', '--cookie', '-A', '--user-agent', '-e', '--referer',
  '-F', '--form', '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--cert', '--key',
  '--cacert', '-w', '--write-out', '--retry',
]);

export interface CurlImport {
  request: RequestItem;
  warnings: string[];
}

export function parseCurl(command: string): CurlImport {
  const argv = shellSplit(command.trim());
  if (argv[0] !== 'curl') throw new Error('Command must start with "curl"');
  const warnings: string[] = [];
  let method: string | null = null;
  let url = '';
  const headers: KeyValue[] = [];
  const data: string[] = [];
  let forceGet = false;
  let user: string | null = null;

  for (let i = 1; i < argv.length; i++) {
    let arg = argv[i];
    let value: string | undefined;
    // --flag=value form
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    } else if (/^-[A-Za-z]./.test(arg) && TAKES_VALUE.has(arg.slice(0, 2))) {
      // -XPOST / -H'x: y' glued form
      value = arg.slice(2);
      arg = arg.slice(0, 2);
    }
    const take = () => {
      if (value !== undefined) return value;
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };

    switch (arg) {
      case '-X': case '--request': method = take().toUpperCase(); break;
      case '-H': case '--header': {
        const h = take();
        const idx = h.indexOf(':');
        if (idx > 0) headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim(), enabled: true });
        break;
      }
      case '-d': case '--data': case '--data-raw': case '--data-binary': case '--data-ascii': {
        const d = take();
        if (d.startsWith('@')) warnings.push(`Body from file ${d.slice(1)} not imported`);
        else data.push(d);
        break;
      }
      case '--data-urlencode': {
        const d = take();
        const eq = d.indexOf('=');
        data.push(eq >= 0 ? `${d.slice(0, eq)}=${encodeURIComponent(d.slice(eq + 1))}` : encodeURIComponent(d));
        break;
      }
      case '-u': case '--user': user = take(); break;
      case '-b': case '--cookie': headers.push({ key: 'Cookie', value: take(), enabled: true }); break;
      case '-A': case '--user-agent': headers.push({ key: 'User-Agent', value: take(), enabled: true }); break;
      case '-e': case '--referer': headers.push({ key: 'Referer', value: take(), enabled: true }); break;
      case '-F': case '--form': take(); warnings.push('Multipart (-F) fields are not supported yet and were skipped'); break;
      case '--url': url = take(); break;
      case '-G': case '--get': forceGet = true; break;
      case '-I': case '--head': method = 'HEAD'; break;
      default:
        if (TAKES_VALUE.has(arg)) take();
        else if (!arg.startsWith('-') && !url) url = arg;
    }
  }
  if (!url) throw new Error('No URL found in cURL command');

  let finalMethod = (method ?? (data.length && !forceGet ? 'POST' : 'GET')) as HttpMethod;
  if (!HTTP_METHODS.includes(finalMethod)) {
    warnings.push(`Method ${finalMethod} not supported, using GET`);
    finalMethod = 'GET';
  }

  if (forceGet && data.length) {
    url += (url.includes('?') ? '&' : '?') + data.join('&');
    data.length = 0;
  }

  const req = newRequest({ method: finalMethod, url, headers });
  try {
    req.name = `${finalMethod} ${new URL(url).pathname}`;
  } catch {
    req.name = `${finalMethod} ${url}`;
  }

  if (user) {
    const idx = user.indexOf(':');
    req.auth = { type: 'basic', username: idx >= 0 ? user.slice(0, idx) : user, password: idx >= 0 ? user.slice(idx + 1) : '' };
  }

  if (data.length) {
    const text = data.join('&');
    const ctIdx = headers.findIndex((h) => h.key.toLowerCase() === 'content-type');
    const ct = ctIdx >= 0 ? headers[ctIdx].value.toLowerCase() : '';
    let looksJson = false;
    try {
      JSON.parse(text);
      looksJson = /^[[{]/.test(text.trim());
    } catch { /* not json */ }
    if (ct.includes('json') || (!ct && looksJson)) {
      req.body = { mode: 'json', text: looksJson ? JSON.stringify(JSON.parse(text), null, 2) : text, form: [] };
      if (ctIdx >= 0) headers.splice(ctIdx, 1); // json mode adds it back
    } else if (!ct || ct.includes('x-www-form-urlencoded')) {
      req.body = {
        mode: 'form-urlencoded',
        text: '',
        form: text.split('&').filter(Boolean).map((pair) => {
          const eq = pair.indexOf('=');
          const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
          return { key: dec(eq >= 0 ? pair.slice(0, eq) : pair), value: dec(eq >= 0 ? pair.slice(eq + 1) : ''), enabled: true };
        }),
      };
      if (ctIdx >= 0) headers.splice(ctIdx, 1);
    } else {
      req.body = { mode: 'text', text, form: [] };
    }
  }
  return { request: req, warnings };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Generate a cURL command from a resolved request (what was actually sent). */
export function toCurl(r: ResolvedRequest): string {
  const parts = ['curl'];
  if (r.method !== 'GET') parts.push('-X', r.method);
  parts.push(shq(r.url));
  for (const [k, v] of r.headers) parts.push('-H', shq(`${k}: ${v}`));
  if (r.body !== undefined && r.body !== '') parts.push('--data-raw', shq(r.body));
  return parts.join(' \\\n  ');
}
