// Workspace = a plain folder you can commit to git:
//   restless.yaml                                           name + active environment
//   collections/<collection>--<id>/collection.yaml          collection name and folders
//   collections/<collection>--<id>/<folder>/<request>--<id>.yaml   one file per request
//   environments/<name>--<id>.yaml                          🔒 values are blank here
//   globals.yaml                                            🔒 values are blank here
//   mcp-servers.yaml
// Personal state (history, 🔒 values) lives in the app's data folder, never in the workspace.
// Workspaces from 0.1 kept requests in requests/; they are read and moved into a collection on the next save.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { emptyWorkspace, type Collection, type Environment, type EnvVar, type HistoryEntry, type McpServerConfig, type RequestItem, type Workspace } from '@restless/core';

export interface SecretStore {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  available: boolean;
}

const GLOBALS = 'globals';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';

// Folder names come from users and imported collections; never let them escape the workspace.
const safeFolder = (folder: string) =>
  folder
    .split('/')
    .map((p) => p.trim().replace(/[<>:"\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, ''))
    .filter((p) => p && p !== '.' && p !== '..')
    .join(path.sep);

const fileExists = (p: string) => fs.access(p).then(() => true, () => false);

async function walkYaml(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkYaml(p)));
    else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) out.push(p);
  }
  return out;
}

async function writeIfChanged(file: string, content: string) {
  try {
    if ((await fs.readFile(file, 'utf8')) === content) return;
  } catch {
    /* new file */
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

function fillRequest(r: RequestItem, collectionId: string): RequestItem {
  r.collectionId = r.collectionId || collectionId;
  r.folder = r.folder ?? '';
  r.params ??= [];
  r.headers ??= [];
  r.body ??= { mode: 'none', text: '', form: [] };
  r.body.form ??= [];
  r.body.text ??= '';
  r.auth ??= { type: 'none' };
  r.captures ??= [];
  return r;
}

export class FileWorkspaceStore {
  constructor(
    public root: string,
    private dataDir: string,
    private secrets: SecretStore,
  ) {}

  private get secretsFile() {
    return path.join(this.dataDir, 'secrets.json');
  }
  private get historyFile() {
    return path.join(this.dataDir, `history-${slug(this.root)}.json`);
  }

  private async readSecrets(): Promise<Record<string, string>> {
    try {
      const raw = JSON.parse(await fs.readFile(this.secretsFile, 'utf8')) as Record<string, string>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        try {
          out[k] = this.secrets.decrypt(v);
        } catch {
          /* unreadable on this machine */
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private async writeSecrets(values: Record<string, string>) {
    const enc: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) enc[k] = this.secrets.encrypt(v);
    await fs.mkdir(this.dataDir, { recursive: true });
    await writeIfChanged(this.secretsFile, JSON.stringify(enc, null, 2));
  }

  private async readYaml<T>(file: string): Promise<T | null> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return null; // not there (yet)
    }
    try {
      return (YAML.parse(text) as T) ?? null;
    } catch (e) {
      console.warn(`Skipping unreadable file ${file}:`, e);
      return null;
    }
  }

  async load(): Promise<Workspace> {
    await fs.mkdir(this.root, { recursive: true });
    const metaFile = path.join(this.root, 'restless.yaml');
    const ws = emptyWorkspace(path.basename(this.root));
    if (await fileExists(metaFile)) {
      const meta = (await this.readYaml<{ name?: string; activeEnvironmentId?: string }>(metaFile)) ?? {};
      ws.name = meta.name ?? ws.name;
      ws.activeEnvironmentId = meta.activeEnvironmentId ?? null;
    } else {
      await this.writeReadme();
    }

    // Collections: each folder under collections/ with a collection.yaml.
    const collDir = path.join(this.root, 'collections');
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(collDir, { withFileTypes: true });
    } catch {
      /* none yet */
    }
    for (const e of entries.filter((x) => x.isDirectory())) {
      const dir = path.join(collDir, e.name);
      const c = await this.readYaml<Collection>(path.join(dir, 'collection.yaml'));
      if (!c?.id) continue;
      ws.collections.push({ id: c.id, name: c.name ?? e.name, folders: c.folders ?? [] });
      for (const f of await walkYaml(dir)) {
        if (path.basename(f) === 'collection.yaml') continue;
        const r = await this.readYaml<RequestItem>(f);
        if (r?.id && r.method) ws.requests.push(fillRequest(r, c.id));
      }
    }
    ws.collections.sort((a, b) => a.name.localeCompare(b.name));

    // Requests saved by version 0.1 (no collections yet). normalizeWorkspace() files them under "My collection".
    for (const f of await walkYaml(path.join(this.root, 'requests'))) {
      const r = await this.readYaml<RequestItem>(f);
      if (r?.id && r.method && !ws.requests.some((x) => x.id === r.id)) ws.requests.push(fillRequest(r, ''));
    }
    ws.requests.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));

    const secrets = await this.readSecrets();
    const unlock = (scope: string, vars: EnvVar[] | undefined) => (vars ?? []).map((v) => (v.secret ? { ...v, value: secrets[`${scope}:${v.key}`] ?? '' } : v));

    for (const f of await walkYaml(path.join(this.root, 'environments'))) {
      const e = await this.readYaml<Environment>(f);
      if (e?.id) ws.environments.push({ ...e, variables: unlock(e.id, e.variables) });
    }

    const globals = await this.readYaml<{ variables?: EnvVar[] }>(path.join(this.root, 'globals.yaml'));
    ws.globals = unlock(GLOBALS, globals?.variables);

    const mcpFile = path.join(this.root, 'mcp-servers.yaml');
    if (await fileExists(mcpFile)) ws.mcpServers = (await this.readYaml<{ servers?: McpServerConfig[] }>(mcpFile))?.servers ?? [];

    try {
      ws.history = JSON.parse(await fs.readFile(this.historyFile, 'utf8')) as HistoryEntry[];
    } catch {
      ws.history = [];
    }
    return ws;
  }

  async save(ws: Workspace): Promise<void> {
    await writeIfChanged(path.join(this.root, 'restless.yaml'), YAML.stringify({ version: 2, name: ws.name, activeEnvironmentId: ws.activeEnvironmentId }));

    // Collections and their requests.
    const collDir = path.join(this.root, 'collections');
    const keep = new Set<string>();
    for (const c of ws.collections) {
      const dir = path.join(collDir, `${slug(c.name)}--${c.id.slice(0, 8)}`);
      const meta = path.join(dir, 'collection.yaml');
      keep.add(meta);
      await writeIfChanged(meta, YAML.stringify({ id: c.id, name: c.name, folders: c.folders }));
      for (const r of ws.requests.filter((x) => x.collectionId === c.id)) {
        const file = path.join(dir, safeFolder(r.folder), `${slug(r.name)}--${r.id.slice(0, 8)}.yaml`);
        keep.add(file);
        const { updatedAt: _u, ...rest } = r;
        if (!rest.captures?.length) delete rest.captures;
        await writeIfChanged(file, YAML.stringify(rest));
      }
    }
    await this.removeStale(collDir, keep);
    // Everything now lives under collections/, so 0.1's requests/ folder can go.
    const legacy = path.join(this.root, 'requests');
    await this.removeStale(legacy, new Set());
    await fs.rmdir(legacy).catch(() => {}); // only succeeds when it is empty

    // Variables: 🔒 values go to the encrypted per-machine store, the rest into the workspace.
    const secrets: Record<string, string> = {};
    const lockUp = (scope: string, vars: EnvVar[]) =>
      vars.map((v) => {
        if (!v.secret) return v;
        secrets[`${scope}:${v.key}`] = v.value;
        return { ...v, value: '' };
      });

    const keepEnv = new Set<string>();
    for (const e of ws.environments) {
      const file = path.join(this.root, 'environments', `${slug(e.name)}--${e.id.slice(0, 8)}.yaml`);
      keepEnv.add(file);
      await writeIfChanged(file, YAML.stringify({ ...e, variables: lockUp(e.id, e.variables) }));
    }
    await this.removeStale(path.join(this.root, 'environments'), keepEnv);
    await writeIfChanged(path.join(this.root, 'globals.yaml'), YAML.stringify({ variables: lockUp(GLOBALS, ws.globals) }));
    await this.writeSecrets(secrets);

    await writeIfChanged(path.join(this.root, 'mcp-servers.yaml'), YAML.stringify({ servers: ws.mcpServers }));
    await fs.mkdir(this.dataDir, { recursive: true });
    await writeIfChanged(this.historyFile, JSON.stringify(ws.history.slice(0, 200)));
  }

  /** Delete Restless-owned yaml files (they have an `id:` field) that are no longer in the workspace. */
  private async removeStale(dir: string, keep: Set<string>) {
    for (const f of await walkYaml(dir)) {
      if (keep.has(f)) continue;
      try {
        const doc = YAML.parse(await fs.readFile(f, 'utf8'));
        if (doc && typeof doc.id === 'string') await fs.unlink(f);
      } catch {
        /* not ours, leave it */
      }
    }
    await this.removeEmptyDirs(dir, dir);
  }

  private async removeEmptyDirs(dir: string, stopAt: string) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory()) await this.removeEmptyDirs(path.join(dir, e.name), stopAt);
    if (dir !== stopAt && (await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
  }

  private async writeReadme() {
    await writeIfChanged(
      path.join(this.root, 'README.md'),
      `# ${path.basename(this.root)}\n\nA Restless workspace. Collections, requests, environments and MCP servers are plain YAML files, so this folder can be committed to git and reviewed in pull requests.\n\nVariable values marked 🔒 are not stored here; each person keeps them encrypted on their own machine.\n`,
    );
  }
}
