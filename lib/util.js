// Shared helpers: filesystem-safe names, UPN validation, XML escaping, HTTP timeouts.
// Also blocks '.'/'..' segments — folder display names (mailbox-controlled) reach
// filesystem paths, and traversal segments must never survive sanitizing.
const safeName = s => {
  const clean = String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
  return !clean || clean === '.' || clean === '..' ? '_' : clean;
};

// Mailbox identifiers come from Graph userPrincipalName. Anything else is rejected
// at the API boundary before it can reach a filesystem path or SOAP envelope.
const UPN_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
const isValidUpn = u => typeof u === 'string' && u.length <= 320 && UPN_RE.test(u);

const xmlEscape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Per-request timeout that still respects the engine's stop signal.
function httpSignal(stopSignal, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs || 120000);
  return stopSignal ? AbortSignal.any([stopSignal, t]) : t;
}

module.exports = { safeName, isValidUpn, xmlEscape, httpSignal };
