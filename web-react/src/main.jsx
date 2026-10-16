import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import MailboxPage from './components/MailboxPage.jsx';
import ComparePage from './components/ComparePage.jsx';
import DedupePage from './components/DedupePage.jsx';
import CopyEmailPage from './components/CopyEmailPage.jsx';
import MoveEmailPage from './components/MoveEmailPage.jsx';
import { LiveProvider } from './live.jsx';
import { DialogHost } from './dialog.jsx';
import MasterStopFab from './components/MasterStopFab.jsx';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const mailboxUpn = params.get('mailbox');
const compareUpn = params.get('compare');
const dedupe = params.get('dedupe');
const copyemail = params.get('copyemail');
const moveemail = params.get('moveemail');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <DialogHost />
      <MasterStopFab />
      {moveemail != null ? (
        <MoveEmailPage />
      ) : copyemail != null ? (
        <CopyEmailPage />
      ) : dedupe != null ? (
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
