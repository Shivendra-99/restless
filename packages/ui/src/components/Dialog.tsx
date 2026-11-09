import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest onClose without re-running the focus effect: parents pass a new function on every render,
  // and re-running would pull focus away from whatever the user is typing in.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    // An element with autoFocus already has focus; otherwise start in the content, not on the close button.
    if (root && !root.contains(document.activeElement)) {
      (root.querySelector<HTMLElement>('.content input, .content textarea, .content select, .content button') ?? root.querySelector<HTMLElement>('button'))?.focus();
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, []);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close.current()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={() => close.current()}>
            ✕
          </button>
        </header>
        <div className="content">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}
