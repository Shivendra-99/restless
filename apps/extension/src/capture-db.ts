// Captured sessions and requests live in IndexedDB (room for bodies; chrome.storage is small).
// The service worker writes; the app page reads. Both are the same extension origin.
import type { CapturedEntry, CaptureSession } from '@restless/core';

const DB_NAME = 'restless-capture';
const MAX_SESSIONS = 40;
export const CHANNEL = 'restless-capture';

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('sessions', { keyPath: 'id' });
      d.createObjectStore('entries', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const result = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Tell open Restless pages that a session changed. */
export function notify(sessionId: string | null) {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ sessionId });
    ch.close();
  } catch {
    /* no listeners */
  }
}

export async function putSession(s: CaptureSession) {
  const tx = (await db()).transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(s);
  await done(tx);
}

export async function getSession(id: string): Promise<CaptureSession | undefined> {
  return result((await db()).transaction('sessions').objectStore('sessions').get(id));
}

export async function listSessions(): Promise<CaptureSession[]> {
  const all = await result<CaptureSession[]>((await db()).transaction('sessions').objectStore('sessions').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

/** Add or replace entries and update the session's count and end time in one transaction. */
export async function putEntries(session: CaptureSession, entries: CapturedEntry[]) {
  const d = await db();
  const tx = d.transaction(['sessions', 'entries'], 'readwrite');
  const store = tx.objectStore('entries');
  for (const e of entries) store.put(e);
  const count = await result(store.index('sessionId').count(session.id));
  const last = entries.reduce((m, e) => Math.max(m, e.startedAt), session.endedAt ?? 0);
  const first = entries.reduce((m, e) => Math.min(m, e.startedAt), session.startedAt);
  Object.assign(session, { entryCount: count, endedAt: last || session.endedAt, startedAt: first });
  tx.objectStore('sessions').put(session);
  await done(tx);
}

export async function getEntries(sessionId: string): Promise<CapturedEntry[]> {
  const list = await result<CapturedEntry[]>((await db()).transaction('entries').objectStore('entries').index('sessionId').getAll(sessionId));
  return list.sort((a, b) => a.startedAt - b.startedAt);
}

export async function deleteSession(id: string) {
  const d = await db();
  const tx = d.transaction(['sessions', 'entries'], 'readwrite');
  tx.objectStore('sessions').delete(id);
  const keys = await result(tx.objectStore('entries').index('sessionId').getAllKeys(id));
  for (const k of keys) tx.objectStore('entries').delete(k);
  await done(tx);
}

/** Keep the newest sessions only (live ones are never removed). */
export async function trim() {
  const all = await listSessions();
  for (const s of all.slice(MAX_SESSIONS)) if (!s.live) await deleteSession(s.id);
}
