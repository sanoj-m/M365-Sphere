// Debug wrapper: run the server with every death path instrumented.
// Usage: node scripts/run-server.js
process.on('exit', c => console.error('[run-server] exit event, code', c));
process.on('uncaughtException', e => { console.error('[run-server] UNCAUGHT', e && e.stack || e); });
process.on('unhandledRejection', e => { console.error('[run-server] UNHANDLED', e && e.stack || e); });
process.on('SIGTERM', () => console.error('[run-server] SIGTERM'));
process.on('SIGINT', () => console.error('[run-server] SIGINT'));
process.on('SIGHUP', () => console.error('[run-server] SIGHUP'));
require('../server.js');
