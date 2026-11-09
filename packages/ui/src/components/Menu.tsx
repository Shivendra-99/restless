import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** A small "⋯" menu. Opens below its button, closes on outside click, Escape, scroll or choice. */
export function Menu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = 180;
    const height = items.length * 32 + 8;
    const top = r.bottom + 4 + height > window.innerHeight ? Math.max(4, r.top - height - 4) : r.bottom + 4;
    setPos({ top, left: Math.min(Math.max(4, r.right - width), window.innerWidth - width - 4) });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (e: Event) => {
      if (e instanceof MouseEvent && (list.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = [...(list.current?.querySelectorAll('button') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        className="icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        ⋯
      </button>
      {open && pos && (
        <div ref={list} className="menu" role="menu" style={{ top: pos.top, left: pos.left }} onClick={(e) => e.stopPropagation()}>
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={it.danger ? 'danger' : undefined}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
