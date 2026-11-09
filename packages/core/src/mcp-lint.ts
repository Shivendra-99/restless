import type { McpTool } from './mcp-session';

export type LintLevel = 'error' | 'warn' | 'info';

export interface LintIssue {
  level: LintLevel;
  tool?: string;
  message: string;
}

export interface LintReport {
  issues: LintIssue[];
  /** Rough token estimate of the tools/list payload a model has to read (chars / 4). */
  approxTokens: number;
  perTool: { name: string; approxTokens: number }[];
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
}

/** Static checks for things that make models misuse a tool. Not a spec validator. */
export function lintTools(tools: McpTool[]): LintReport {
  const issues: LintIssue[] = [];
  const seen = new Map<string, number>();
  for (const t of tools) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
  for (const [name, n] of seen) if (n > 1) issues.push({ level: 'error', tool: name, message: `Tool name is used ${n} times` });

  for (const t of tools) {
    if (!NAME_RE.test(t.name)) issues.push({ level: 'warn', tool: t.name, message: 'Name should be 1-128 chars of letters, digits, _ - .' });
    const desc = (t.description ?? '').trim();
    if (!desc) issues.push({ level: 'error', tool: t.name, message: 'Missing description; models pick tools mostly from this text' });
    else if (desc.length < 20) issues.push({ level: 'warn', tool: t.name, message: `Description is very short (${desc.length} chars)` });
    else if (desc.length > 1500) issues.push({ level: 'info', tool: t.name, message: `Description is long (${desc.length} chars); costs tokens on every request` });

    const schema = (t.inputSchema ?? {}) as JsonSchema;
    if (schema.type !== 'object') issues.push({ level: 'error', tool: t.name, message: 'inputSchema.type must be "object"' });
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) {
      if (!(req in props)) issues.push({ level: 'error', tool: t.name, message: `Required param "${req}" is not defined in properties` });
    }
    for (const [pname, p] of Object.entries(props)) {
      if (!p.description) issues.push({ level: 'warn', tool: t.name, message: `Param "${pname}" has no description` });
      if (!p.type && !p.enum && !(p as { anyOf?: unknown }).anyOf && !(p as { oneOf?: unknown }).oneOf && !(p as { $ref?: unknown }).$ref) {
        issues.push({ level: 'warn', tool: t.name, message: `Param "${pname}" has no type` });
      }
    }
  }
  const perTool = tools.map((t) => ({ name: t.name, approxTokens: Math.ceil(JSON.stringify(t).length / 4) }));
  return { issues, approxTokens: Math.ceil(JSON.stringify({ tools }).length / 4), perTool };
}

/** Build an example argument object from a JSON Schema, used to prefill the tool form. */
export function exampleFromSchema(schema: unknown, depth = 0): unknown {
  const s = (schema ?? {}) as JsonSchema & { anyOf?: JsonSchema[]; oneOf?: JsonSchema[] };
  if (depth > 6) return null;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  const alt = s.anyOf?.[0] ?? s.oneOf?.[0];
  if (alt) return exampleFromSchema(alt, depth + 1);
  const type = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        if ((s.required ?? []).includes(k) || depth === 0) out[k] = exampleFromSchema(v, depth + 1);
      }
      return out;
    }
    case 'array': return [];
    case 'string': return '';
    case 'integer':
    case 'number': return 0;
    case 'boolean': return false;
    default: return s.properties ? exampleFromSchema({ ...s, type: 'object' }, depth) : null;
  }
}

/** Check required top-level args before sending, so the user sees a friendly message instead of a server error. */
export function missingRequired(schema: unknown, args: Record<string, unknown>): string[] {
  const s = (schema ?? {}) as JsonSchema;
  return (s.required ?? []).filter((k) => args[k] === undefined || args[k] === '' || args[k] === null);
}
