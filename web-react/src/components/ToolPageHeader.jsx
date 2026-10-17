import React from 'react';
import { Copy, GitCompare, MoveRight } from 'lucide-react';

const tools = [
  { id: 'compare', href: '/?compare=', label: 'Compare', icon: GitCompare, title: 'Open the side-by-side compare page — local backup on the left, live mailbox on the right, copy/move emails between them' },
  { id: 'dedupe', href: '/?dedupe', label: 'Dedupe', icon: Copy, title: 'Find and move duplicate emails aside — in the local backup store or the live online mailbox' },
  { id: 'copyemail', href: '/?copyemail', label: 'Copy email', icon: Copy, title: 'Copy backed-up folders into a live mailbox folder or another local backup — copy-only, duplicates are skipped' },
  { id: 'moveemail', href: '/?moveemail', label: 'Move email', icon: MoveRight, title: 'Move backed-up or live folders into a live mailbox folder — source is removed only after the destination copy is verified' },
];

export function EmailToolsNav({ active, children }) {
  return (
    <nav className="main-nav" aria-label="Email tools">
      {children}
      {tools.map(({ id, href, label, icon: Icon, title }) => (
        <a key={id} className={`nav-action${active === id ? ' active' : ''}`} href={href} title={title} aria-current={active === id ? 'page' : undefined}>
          <Icon size={16} aria-hidden="true" /><span>{label}</span>
        </a>
      ))}
    </nav>
  );
}

export default function ToolPageHeader({ active, title, children, actions }) {
  return (
    <header className="mailbox-page-head tool-page-head">
      <div className="navbar">
        <a className="brand" href="/" title="Go to homepage">
          <img className="brand-icon" src="/logo.png" alt="M365Sphere logo" />
          <div className="brand-copy">
            <h1>M365Sphere</h1>
            <span className="header-sub">Mailbox backup, verification and PST export for Microsoft 365.</span>
          </div>
        </a>
        <EmailToolsNav active={active} />
      </div>
      <div className="workflow-bar tool-page-controls">
        <h2 className="tool-page-title">{title}</h2>
        <div className="tool-page-filters">{children}</div>
        <div className="workflow-actions tool-page-actions">{actions}</div>
      </div>
    </header>
  );
}
