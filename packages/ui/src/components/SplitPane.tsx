import { Children, useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  /** Exactly two parts. */
  children: ReactNode;
  /** 'rows' stacks them (bar is horizontal), 'columns' puts them side by side (bar is vertical). */
  direction?: 'rows' | 'columns';
  /** Size the first part as a share of the whole ('fraction', 0–1) or in pixels ('px'). */
  unit?: 'fraction' | 'px';
  /** Size of the first part at first and after a reset (double-click / Enter). */
  defaultSize: number;
  /** Smallest size of the first and second part, in pixels. */
  minFirst?: number;
  minSecond?: number;
  /** Remembers the size between sessions under this key. */
  storageKey: string;
  label: string;
  className?: string;
}

function readSize(key: string, fallback: number, unit: 'fraction' | 'px') {
  try {
    const v = Number(localStorage.getItem(key));
    if (unit === 'fraction') return v > 0 && v < 1 ? v : fallback;
    return v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Two parts with a bar between them to drag (or use arrow keys on) to change how much room each gets. */
export function SplitPane({ children, direction = 'rows', unit = 'fraction', defaultSize, minFirst = 96, minSecond = 96, storageKey, label, className = '' }: Props) {
  const [size, setSize] = useState(() => readSize(storageKey, defaultSize, unit));
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const rows = direction === 'rows';
  const [first, second] = Children.toArray(children);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(size));
    } catch {
      /* not kept */
    }
  }, [storageKey, size]);

  const total = () => {
    const r = box.current?.getBoundingClientRect();
    return r ? (rows ? r.height : r.width) : 0;
  };

  /** Keep both parts at least their minimum size. Works in pixels, returns the stored unit. */
  const clampPx = (px: number) => {
    const t = total();
    if (!t) return px;
    const max = Math.max(minFirst, t - minSecond - 9);
    return Math.min(max, Math.max(minFirst, px));
  };
  const toPx = (v: number) => (unit === 'px' ? v : v * total());
  const fromPx = (px: number) => (unit === 'px' ? Math.round(px) : total() ? px / total() : size);
  const set = (px: number) => setSize(fromPx(clampPx(px)));

  const step = unit === 'px' ? 24 : total() * 0.05;
  const firstTrack = unit === 'px' ? `${size}px` : `minmax(0, ${(size * 100).toFixed(2)}%)`;
  const template = `${firstTrack} 9px minmax(0, 1fr)`;

  return (
    <div
      ref={box}
      className={`split ${rows ? 'split-rows' : 'split-columns'} ${dragging ? 'dragging' : ''} ${className}`}
      style={rows ? { gridTemplateRows: template } : { gridTemplateColumns: template }}
    >
      {first}
      <div
        className="split-handle"
        role="separator"
        tabIndex={0}
        aria-orientation={rows ? 'horizontal' : 'vertical'}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={total() ? Math.round((toPx(size) / total()) * 100) : undefined}
        title="Drag to resize. Double-click to reset."
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          const r = box.current!.getBoundingClientRect();
          set(rows ? e.clientY - r.top : e.clientX - r.left);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
        }}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => setSize(defaultSize)}
        onKeyDown={(e) => {
          const back = rows ? 'ArrowUp' : 'ArrowLeft';
          const fwd = rows ? 'ArrowDown' : 'ArrowRight';
          const now = toPx(size);
          const next = e.key === back ? now - step : e.key === fwd ? now + step : e.key === 'Home' ? 0 : e.key === 'End' ? Infinity : null;
          if (e.key === 'Enter') {
            e.preventDefault();
            setSize(defaultSize);
            return;
          }
          if (next === null) return;
          e.preventDefault();
          set(next);
        }}
      >
        <span className="split-grip" />
      </div>
      {second}
    </div>
  );
}
