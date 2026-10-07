import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import MailboxPage from './components/MailboxPage.jsx';
import ComparePage from './components/ComparePage.jsx';
import DedupePage from './components/DedupePage.jsx';
import { LiveProvider } from './live.jsx';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const mailboxUpn = params.get('mailbox');
const compareUpn = params.get('compare');
const dedupe = params.get('dedupe');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {dedupe != null ? (
        <DedupePage />
      ) : compareUpn != null ? (
        <ComparePage upn={compareUpn} />
      ) : mailboxUpn ? (
        <MailboxPage upn={mailboxUpn} />
      ) : (
        <LiveProvider>
          <App />
        </LiveProvider>
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
