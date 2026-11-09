import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeWorkspace, type Bridge, type Workspace } from '@restless/core';
import { errorText } from './util';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const SAVE_DELAY_MS = 300;

/**
 * Loads the workspace once and auto-saves every change. There is no "unsaved" state to lose:
 * saves are batched for a moment, written one after another (never overlapping), and flushed
 * right away when the window is hidden, reloaded or closed.
 */
export function useWorkspace(bridge: Bridge) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [location, setLocation] = useState('');
  const dirty = useRef(false);
  const pending = useRef<Workspace | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const writing = useRef<Promise<void>>(Promise.resolve());

  const reload = useCallback(async () => {
    try {
      // Older saves have no collections or globals; normalize fills them in and moves stray requests into a collection.
      const w = normalizeWorkspace(await bridge.storage.load());
      dirty.current = false;
      setWs(w);
      setLocation(await bridge.storage.location());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [bridge]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const w = pending.current;
    if (!w) return;
    pending.current = null;
    setSaveState('saving');
    // Chained, so an older snapshot can never finish after a newer one.
    writing.current = writing.current
      .then(() => bridge.storage.save(w))
      .then(
        () => setSaveState(pending.current ? 'saving' : 'saved'),
        (e) => {
          console.error('save failed', e);
          setSaveState('error');
        },
      );
  }, [bridge]);

  const update = useCallback((fn: (w: Workspace) => Workspace) => {
    dirty.current = true;
    setWs((prev) => (prev ? fn(prev) : prev));
  }, []);

  useEffect(() => {
    if (!ws || !dirty.current) return;
    dirty.current = false;
    pending.current = ws;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  }, [ws, flush]);

  useEffect(() => {
    const now = () => flush();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', now);
    window.addEventListener('beforeunload', now);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', now);
      window.removeEventListener('beforeunload', now);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flush]);

  return { ws, update, saveState, loadError, location, reload };
}
