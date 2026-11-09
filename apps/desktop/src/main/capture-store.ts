// Captured sessions on disk, in the app's data folder (not the workspace: captures hold real
// cookies and tokens, so they stay out of folders that may be committed to git).
//   <id>.session.json   the session
//   <id>.jsonl          its requests, one per line; a later line with the same id replaces an earlier one
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CapturedEntry, CaptureSession } from '@restless/core';

const MAX_SESSIONS = 60;
const SAFE_ID = /^[\w-]{1,80}$/;

export class CaptureStore {
  private sessions: Map<string, CaptureSession> | null = null;
  private ids = new Map<string, Set<string>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  /** One write at a time. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private file(id: string, ext: 'session.json' | 'jsonl') {
    if (!SAFE_ID.test(id)) throw new Error('Invalid capture id');
    return path.join(this.dir, `${id}.${ext}`);
  }

  private async load(): Promise<Map<string, CaptureSession>> {
    if (this.sessions) return this.sessions;
    const map = new Map<string, CaptureSession>();
    await fs.mkdir(this.dir, { recursive: true });
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.session.json')) continue;
      try {
        const s = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')) as CaptureSession;
        if (s && typeof s.id === 'string') map.set(s.id, s);
      } catch {
        /* skip a broken file */
      }
    }
    this.sessions = map;
    return map;
  }

  async list(): Promise<CaptureSession[]> {
    return [...(await this.load()).values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  async entries(id: string): Promise<CapturedEntry[]> {
    let text = '';
    try {
      text = await fs.readFile(this.file(id, 'jsonl'), 'utf8');
    } catch {
      return [];
    }
    const byId = new Map<string, CapturedEntry>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as CapturedEntry;
        byId.set(e.id, e);
      } catch {
        /* a line cut short by a crash */
      }
    }
    this.ids.set(id, new Set(byId.keys()));
    return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Add a session, or update it and add or replace some of its requests. */
  put(incoming: CaptureSession, entries: CapturedEntry[]): Promise<CaptureSession> {
    return this.run(async () => {
      const sessions = await this.load();
      const prev = sessions.get(incoming.id);
      if (!this.ids.has(incoming.id)) await this.entries(incoming.id);
      const ids = this.ids.get(incoming.id) ?? new Set<string>();
      if (entries.length) {
        await fs.appendFile(this.file(incoming.id, 'jsonl'), entries.map((e) => `${JSON.stringify({ ...e, sessionId: incoming.id })}\n`).join(''));
        for (const e of entries) ids.add(e.id);
        this.ids.set(incoming.id, ids);
      }
      const times = entries.map((e) => e.startedAt);
      const session: CaptureSession = {
        ...prev,
        ...incoming,
        startedAt: Math.min(prev?.startedAt ?? Infinity, incoming.startedAt, ...times),
        endedAt: Math.max(prev?.endedAt ?? 0, incoming.endedAt ?? 0, ...times) || undefined,
        entryCount: ids.size,
      };
      sessions.set(session.id, session);
      await fs.writeFile(this.file(session.id, 'session.json'), JSON.stringify(session));
      if (!prev) await this.trim();
      return session;
    });
  }

  delete(id: string): Promise<void> {
    return this.run(() => this.remove(id));
  }

  private async remove(id: string) {
    (await this.load()).delete(id);
    this.ids.delete(id);
    await fs.rm(this.file(id, 'session.json'), { force: true });
    await fs.rm(this.file(id, 'jsonl'), { force: true });
  }

  /** Keep the newest sessions; never drop one that is still live. */
  private async trim() {
    const all = [...(await this.load()).values()].sort((a, b) => b.startedAt - a.startedAt);
    for (const s of all.slice(MAX_SESSIONS)) if (!s.live) await this.remove(s.id);
  }

  /** Sessions still marked live when the app starts were cut off (browser or app closed). */
  async closeStale() {
    await this.run(async () => {
      for (const s of (await this.load()).values()) {
        if (!s.live) continue;
        s.live = false;
        await fs.writeFile(this.file(s.id, 'session.json'), JSON.stringify(s));
      }
    });
  }
}
