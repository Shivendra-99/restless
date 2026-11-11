import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  top: ReactNode;
  bottom: ReactNode;
  /** Remembers the size between sessions under this key. */
  storageKey: string;
  /** Share of the height the top part gets at first and after a reset (double-click). */
  defaultFraction?: number;
  /** Smallest height either part can be dragged to, in pixels. */
  minPx?: number;
  label: string;
}

const STEP = 0.05;

function readFraction(key: string, fallback: number) {
  try {
    const v = Number(localStorage.getItem(key));
    return v > 0 && v < 1 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Two parts stacked, with a bar between them to drag (or use arrow keys on) to change how much room each gets. */
export function SplitPane({ top, bottom, storageKey, defaultFraction = 0.42, minPx = 96, label }: Props) {
  const [fraction, setFraction] = useState(() => readFraction(storageKey, defaultFraction));
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(fraction));
    } catch {
      /* not kept */
    }
  }, [storageKey, fraction]);

  /** Keep both parts at least minPx tall. */
  const clamp = (f: number) => {
    const h = box.current?.getBoundingClientRect().height ?? 0;
    const min = h > minPx * 2 ? minPx / h : 0.1;
    return Math.min(1 - min, Math.max(min, f));
  };

  const fromPointer = (clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    setFraction(clamp((clientY - r.top) / r.height));
  };

  return (
    <div ref={box} className={`split ${dragging ? 'dragging' : ''}`} style={{ gridTemplateRows: `minmax(0, ${(fraction * 100).toFixed(2)}%) 9px minmax(0, 1fr)` }}>
      {top}
      <div
        className="split-handle"
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        title="Drag to resize. Double-click to reset."
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => dragging && fromPointer(e.clientY)}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
        }}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => setFraction(defaultFraction)}
        onKeyDown={(e) => {
          const next =
            e.key === 'ArrowUp' ? fraction - STEP
            : e.key === 'ArrowDown' ? fraction + STEP
            : e.key === 'Home' ? 0
            : e.key === 'End' ? 1
            : e.key === 'Enter' ? defaultFraction
            : null;
          if (next === null) return;
          e.preventDefault();
          setFraction(clamp(next));
        }}
      >
        <span className="split-grip" />
      </div>
      {bottom}
    </div>
  );
}
