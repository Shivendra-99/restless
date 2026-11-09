import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bridge, Workspace } from '@restless/core';
import { debounce, errorText } from './util';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Loads the workspace once and auto-saves every change (debounced). No "unsaved" state to lose. */
export function useWorkspace(bridge: Bridge) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [location, setLocation] = useState('');
  const latest = useRef<Workspace | null>(null);

  const reload = useCallback(async () => {
    try {
      const w = await bridge.storage.load();
      latest.current = w;
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

  const save = useMemo(
    () =>
      debounce(async (w: Workspace) => {
        setSaveState('saving');
        try {
          await bridge.storage.save(w);
          setSaveState('saved');
        } catch (e) {
          console.error('save failed', e);
          setSaveState('error');
        }
      }, 400),
    [bridge],
  );

  const update = useCallback(
    (fn: (w: Workspace) => Workspace) => {
      setWs((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        latest.current = next;
        save(next);
        return next;
      });
    },
    [save],
  );

  return { ws, update, saveState, loadError, location, reload };
}
