import { useEffect, useRef } from 'react';

// Focus trap + Escape handling for a dialog element. Attach the returned ref
// to the dialog container (which should carry role="dialog" aria-modal="true").
export function useModal(onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    const focusables = () => [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(n => !n.disabled && n.offsetParent !== null);
    const f = focusables();
    (f[0] || el).focus();

    const onKey = e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const items = focusables();
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      if (prev && prev.focus) prev.focus();
    };
  }, []);
  return ref;
}
