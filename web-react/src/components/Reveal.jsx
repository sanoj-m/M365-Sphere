import React, { useEffect, useRef, useState } from 'react';

export default function Reveal({ index = 0, className = '', children, ...rest }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return (
    <div ref={ref} className={`reveal${visible ? ' is-visible' : ''} ${className}`} style={{ '--index': index }} {...rest}>
      {children}
    </div>
  );
}
