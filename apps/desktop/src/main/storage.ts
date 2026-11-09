// Workspace = a plain folder you can commit to git:
//   probe.yaml                  name + active environment
//   requests/<folder>/<name>--<id>.yaml   one file per request
//   environments/<name>--<id>.yaml        secret values are blanked here
//   mcp-servers.yaml
// Personal state (history, secret values) lives in the app's data folder, never in the workspace.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { emptyWorkspace, type Environment, type HistoryEntry, type McpServerConfig, type RequestItem, type Workspace } from '@probe/core';

export interface SecretStore {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  available: boolean;
}

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
    .map((p) => p.trim().replace(/[<>:"\\|?*\u0000-\u001f]/g, '_'))
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

  async load(): Promise<Workspace> {
    await fs.mkdir(this.root, { recursive: true });
    const metaFile = path.join(this.root, 'probe.yaml');
    const ws = emptyWorkspace(path.basename(this.root));
    if (await fileExists(metaFile)) {
      const meta = YAML.parse(await fs.readFile(metaFile, 'utf8')) ?? {};
      ws.name = meta.name ?? ws.name;
      ws.activeEnvironmentId = meta.activeEnvironmentId ?? null;
    } else {
      await this.writeReadme();
    }

    for (const f of await walkYaml(path.join(this.root, 'requests'))) {
      try {
        const r = YAML.parse(await fs.readFile(f, 'utf8')) as RequestItem;
        if (r && r.id && r.method) {
          r.params ??= [];
          r.headers ??= [];
          r.body ??= { mode: 'none', text: '', form: [] };
          r.body.form ??= [];
          r.body.text ??= '';
          r.auth ??= { type: 'none' };
          r.folder = r.folder ?? '';
          ws.requests.push(r);
        }
      } catch (e) {
        console.warn(`Skipping unreadable request file ${f}:`, e);
      }
    }
    ws.requests.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));

    const secrets = await this.readSecrets();
    for (const f of await walkYaml(path.join(this.root, 'environments'))) {
      try {
        const e = YAML.parse(await fs.readFile(f, 'utf8')) as Environment;
        if (e && e.id) {
          e.variables = (e.variables ?? []).map((v) => (v.secret ? { ...v, value: secrets[`${e.id}:${v.key}`] ?? '' } : v));
          ws.environments.push(e);
        }
      } catch (err) {
        console.warn(`Skipping unreadable environment file ${f}:`, err);
      }
    }

    const mcpFile = path.join(this.root, 'mcp-servers.yaml');
    if (await fileExists(mcpFile)) ws.mcpServers = (YAML.parse(await fs.readFile(mcpFile, 'utf8')) as { servers?: McpServerConfig[] })?.servers ?? [];

    try {
      ws.history = JSON.parse(await fs.readFile(this.historyFile, 'utf8')) as HistoryEntry[];
    } catch {
      ws.history = [];
    }
    return ws;
  }

  async save(ws: Workspace): Promise<void> {
    await writeIfChanged(path.join(this.root, 'probe.yaml'), YAML.stringify({ version: 1, name: ws.name, activeEnvironmentId: ws.activeEnvironmentId }));

    const keep = new Set<string>();
    for (const r of ws.requests) {
      const file = path.join(this.root, 'requests', safeFolder(r.folder), `${slug(r.name)}--${r.id.slice(0, 8)}.yaml`);
      keep.add(file);
      const { updatedAt: _u, ...rest } = r;
      await writeIfChanged(file, YAML.stringify(rest));
    }
    await this.removeStale(path.join(this.root, 'requests'), keep);

    const secrets = await this.readSecrets();
    const keepEnv = new Set<string>();
    for (const e of ws.environments) {
      const file = path.join(this.root, 'environments', `${slug(e.name)}--${e.id.slice(0, 8)}.yaml`);
      keepEnv.add(file);
      for (const k of Object.keys(secrets)) if (k.startsWith(`${e.id}:`)) delete secrets[k];
      const vars = e.variables.map((v) => {
        if (!v.secret) return v;
        secrets[`${e.id}:${v.key}`] = v.value;
        return { ...v, value: '' };
      });
      await writeIfChanged(file, YAML.stringify({ ...e, variables: vars }));
    }
    // Drop secrets of deleted environments.
    for (const k of Object.keys(secrets)) if (!ws.environments.some((e) => k.startsWith(`${e.id}:`))) delete secrets[k];
    await this.writeSecrets(secrets);
    await this.removeStale(path.join(this.root, 'environments'), keepEnv);

    await writeIfChanged(path.join(this.root, 'mcp-servers.yaml'), YAML.stringify({ servers: ws.mcpServers }));
    await fs.mkdir(this.dataDir, { recursive: true });
    await writeIfChanged(this.historyFile, JSON.stringify(ws.history.slice(0, 200)));
  }

  /** Delete Probe-owned yaml files (they have an `id:` field) that are no longer in the workspace. */
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
      `# ${path.basename(this.root)}\n\nA Probe workspace. Every request, environment and MCP server is a plain YAML file, so this folder can be committed to git and reviewed in pull requests.\n\nSecret environment values are not stored here; each person keeps them encrypted on their own machine.\n`,
    );
  }
}
