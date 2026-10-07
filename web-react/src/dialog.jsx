// In-app dialogs & toasts — replaces every window.confirm/alert so nothing ever
// pops up in the browser chrome. Global singleton: mount <DialogHost/> once at root.
// Usage: await dialog.confirm({title, message, danger, okText}) → bool
//        await dialog.choose({title, message, options:[{label, value, danger?, primary?}]}) → value | null
//        dialog.notify(message, kind?) — transient toast
import React, { useState, useEffect, useCallback } from 'react';

let push = null; // host registers its dispatcher here

export const dialog = {
  confirm(opts) { return push ? push({ type: 'confirm', ...opts }) : Promise.resolve(false); },
  choose(opts) { return push ? push({ type: 'choose', ...opts }) : Promise.resolve(null); },
  notify(message, kind = 'info') { if (push) push({ type: 'toast', message, kind }); }
};

const ICONS = {
  info: 'ℹ', danger: '⚠', choose: '⇄'
};

export function DialogHost() {
  const [current, setCurrent] = useState(null); // {type, …, resolve}
  const [toasts, setToasts] = useState([]);

  const dispatch = useCallback(req => {
    if (req.type === 'toast') {
      const id = Date.now() + Math.random();
      setToasts(t => [...t, { id, message: req.message, kind: req.kind }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000);
      return null;
    }
    return new Promise(resolve => setCurrent({ ...req, resolve }));
  }, []);

  useEffect(() => { push = dispatch; return () => { push = null; }; }, [dispatch]);

  const close = val => { current?.resolve(val); setCurrent(null); };
  const intent = current ? (current.danger ? 'danger' : current.type === 'choose' ? 'choose' : 'info') : 'info';

  return (
    <>
      {current && (
        <div className="modal-backdrop dialog-backdrop" onClick={() => close(current.type === 'confirm' ? false : null)}>
          <div className="modal-card app-dialog" role="alertdialog" aria-modal="true"
            aria-label={current.title || 'Confirm'} onClick={e => e.stopPropagation()}>
            <div className={`dialog-icon ${intent}`} aria-hidden="true">{ICONS[intent]}</div>
            <div className="dialog-body">
              <h3 className="dialog-title">{current.title || 'Please confirm'}</h3>
              <p className="dialog-message">{current.message}</p>
              <div className="dialog-actions">
                <button className="btn small ghost" onClick={() => close(current.type === 'confirm' ? false : null)}>
                  {current.cancelText || 'Cancel'}
                </button>
                {current.type === 'confirm' && (
                  <button className={`btn small ${current.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => close(true)}>
                    {current.okText || 'OK'}
                  </button>
                )}
                {current.type === 'choose' && (current.options || []).map((o, i) => (
                  <button key={o.label} className={`btn small ${o.danger ? 'danger' : o.primary || i === 0 ? 'primary' : ''}`}
                    autoFocus={i === 0} onClick={() => close(o.value)}>{o.label}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="app-toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={`app-toast ${t.kind}`} onClick={() => setToasts(x => x.filter(y => y.id !== t.id))}>{t.message}</div>)}
      </div>
    </>
  );
}
