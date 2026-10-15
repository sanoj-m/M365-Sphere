// EWS client for the online archive (Graph cannot see archives).
// Requires: Office 365 Exchange Online -> full_access_as_app
//           + New-ManagementRoleAssignment -App <clientId> -Role "ApplicationImpersonation"
const { XMLParser } = require('fast-xml-parser');
const { xmlEscape, httpSignal } = require('./util');
const EWS_URL = 'https://outlook.office365.com/EWS/Exchange.asmx';

// Transient SOAP faults worth retrying with the same backoff as HTTP 429.
const RETRYABLE_FAULT = /ErrorServerBusy|ErrorTimeoutExpired|ErrorInternalServerTransientError/i;

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseTagValue: false
});

function soap(body, upn) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
<soap:Header>
  <t:RequestServerVersion Version="Exchange2013_SP1"/>
  <t:ExchangeImpersonation><t:ConnectingSID><t:PrimarySmtpAddress>${xmlEscape(upn)}</t:PrimarySmtpAddress></t:ConnectingSID></t:ExchangeImpersonation>
</soap:Header>
<soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}

// A m:Folders element holds typed children (Folder, CalendarFolder, ContactsFolder,
// TasksFolder, SearchFolder) — flatten all of them into one list.
function folderList(folders) {
  if (!folders) return [];
  const out = [];
  for (const v of Object.values(folders)) {
    if (Array.isArray(v)) out.push(...v);
    else if (v && typeof v === 'object') out.push(v);
  }
  return out.filter(f => f && f.FolderId);
}

class EwsClient {
  constructor(auth, log, cfg = {}) {
    this.auth = auth; this.log = log; this.cooldownUntil = 0; this.signal = null;
    this.timeoutMs = cfg.httpTimeoutMs || 120000;
  }

  _aborted() {
    const e = new Error('operation aborted');
    e.name = 'AbortError'; e.aborted = true;
    return e;
  }

  _sleep(ms, sig) {
    return new Promise((res, rej) => {
      if (sig && sig.aborted) { rej(this._aborted()); return; }
      const t = setTimeout(() => { cleanup(); res(); }, ms);
      const onAbort = () => { clearTimeout(t); rej(this._aborted()); };
      const cleanup = () => { if (sig) sig.removeEventListener('abort', onAbort); };
      if (sig) sig.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Per-operation abort signal: callers (engine run, sizes job) pass their own
  // signal so concurrent operations don't share one abort channel. this.signal
  // remains as the fallback for callers that set it per run (the engine).
  async call(upn, body, retries = 10, signal = null) {
    const sig = signal || this.signal;
    for (let i = 0; i < retries; i++) {
      if (sig && sig.aborted) throw this._aborted();
      // Shared throttle cooldown: when any request sees a 429, every worker
      // waits it out instead of stampeding the mailbox with parallel retries.
      const cool = this.cooldownUntil - Date.now();
      if (cool > 0) await this._sleep(cool + Math.random() * 500, sig);
      // Token fetch is inside the retry loop: a token-endpoint blip retries with backoff.
      let tok;
      try {
        tok = await this.auth.ewsToken();
      } catch (e) {
        if (e.aborted || e.name === 'AbortError' || (sig && sig.aborted)) throw this._aborted();
        if (i === retries - 1) throw e;
        const wait = Math.min(60, 2 ** i * 2) + Math.random() * 3;
        await this._sleep(wait * 1000, sig);
        continue;
      }
      let r;
      try {
        r = await fetch(EWS_URL, {
          method: 'POST',
          signal: httpSignal(sig, this.timeoutMs),
          headers: {
            Authorization: `Bearer ${tok}`,
            'Content-Type': 'text/xml; charset=utf-8',
            'X-AnchorMailbox': upn
          },
          body: soap(body, upn)
        });
      } catch (e) {
        if (e.aborted || e.name === 'AbortError' || (sig && sig.aborted)) throw this._aborted();
        if (i === retries - 1) throw e;
        const wait = Math.min(60, 2 ** i * 2) + Math.random() * 3;
        await this._sleep(wait * 1000, sig);
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        let wait;
        if (r.status === 429) {
          const ra = parseInt(r.headers.get('retry-after') || '5', 10);
          // Escalate on repeated throttling — a fixed Retry-After just re-hits the limit.
          wait = Math.min(120, ra * (i + 1));
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(30, ra) * 1000);
        } else {
          wait = Math.min(60, 2 ** i * 2);
        }
        wait += Math.random() * 3;
        await this._sleep(wait * 1000, sig);
        continue;
      }
      const text = await r.text();
      if (!r.ok) {
        const err = new Error(`EWS HTTP ${r.status}: ${text.slice(0, 300)}`);
        err.status = r.status;
        throw err;
      }
      const j = parser.parse(text);
      const env = j.Envelope || j;
      const fault = env && env.Body && env.Body.Fault;
      if (fault) {
        const msg = (fault.faultstring || fault.Reason || 'EWS fault').toString().slice(0, 300);
        if (RETRYABLE_FAULT.test(msg) && i < retries - 1) {
          const wait = Math.min(60, 2 ** i * 2) + Math.random() * 3;
          await this._sleep(wait * 1000, sig);
          continue;
        }
        const err = new Error(`EWS fault: ${msg}`);
        err.fault = msg;
        throw err;
      }
      return env.Body;
    }
    throw new Error('EWS throttled persistently');
  }

  // First response message of a given name; unwraps single-element arrays.
  resp(body, name) {
    const rms = body[`${name}Response`].ResponseMessages[`${name}ResponseMessage`];
    const rm = Array.isArray(rms) ? rms[0] : rms;
    const cls = rm.ResponseClass || rm['@ResponseClass'];
    if (cls !== 'Success') {
      const code = rm.ResponseCode && rm.ResponseCode !== 'NoError' ? rm.ResponseCode : '';
      const detail = [code, rm.MessageText].filter(Boolean).join(' — ') || 'unknown error';
      const err = new Error(`EWS ${name} failed: ${detail}`);
      err.fault = detail;
      throw err;
    }
    return rm;
  }

  // Total size (bytes) of a folder tree, using PR_MESSAGE_SIZE_EXTENDED (0x0E08)
  // per folder and summing the subtree. root is a DistinguishedFolderId such as
  // 'msgfolderroot' or 'archivemsgfolderroot'.
  async folderSize(upn, root, onProgress, concurrency = 6, signal = null) {
    const sizeProp = f => {
      const ep = f && f.ExtendedProperty;
      if (!ep) return 0;
      const v = Array.isArray(ep) ? ep[0] : ep;
      return parseInt((v && v.Value) || '0', 10) || 0;
    };
    const shape = `<m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:ExtendedFieldURI PropertyTag="0x0E08" PropertyType="Long"/></t:AdditionalProperties></m:FolderShape>`;
    const rootBody = `<m:GetFolder>${shape}<m:FolderIds><t:DistinguishedFolderId Id="${xmlEscape(root)}"/></m:FolderIds></m:GetFolder>`;
    const rootRm = this.resp(await this.call(upn, rootBody, 10, signal), 'GetFolder');
    const rootFolders = folderList(rootRm.Folders);
    let total = sizeProp(rootFolders[0]);
    let scanned = 1;
    // Breadth-first walk with a worker pool: sibling folders are scanned in
    // parallel instead of recursing one folder at a time (much faster on wide
    // trees). Pages within one folder stay sequential (IndexedPageFolderView).
    const queue = [`<t:DistinguishedFolderId Id="${xmlEscape(root)}"/>`];
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const folderRef = queue[next++];
        let offset = 0;
        for (;;) {
          const body = `<m:FindFolder Traversal="Shallow">
  ${shape}
  <m:IndexedPageFolderView MaxEntriesReturned="100" Offset="${offset}" BaseOffset="0"/>
  <m:ParentFolderIds>${folderRef}</m:ParentFolderIds>
</m:FindFolder>`;
          const rm = this.resp(await this.call(upn, body, 10, signal), 'FindFolder');
          const rf = rm.RootFolder;
          const folders = folderList(rf.Folders);
          for (const f of folders) {
            total += sizeProp(f);
            scanned++;
            queue.push(`<t:FolderId Id="${xmlEscape(f.FolderId['@Id'])}"/>`);
          }
          if (onProgress) onProgress(scanned, total);
          const more = String(rf['@IncludesLastItemInRange']).toLowerCase() === 'false';
          if (!more || folders.length === 0) break;
          offset += folders.length;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return total;
  }

  // Server-reported sizes: { primaryBytes, archiveBytes } — archiveBytes null when
  // the mailbox has no online archive.
  async mailboxSizes(upn, onProgress, concurrency, signal = null) {
    const primaryBytes = await this.folderSize(upn, 'msgfolderroot', onProgress, concurrency, signal);
    let archiveBytes = null;
    try {
      archiveBytes = await this.folderSize(upn, 'archivemsgfolderroot', onProgress, concurrency, signal);
    } catch (e) {
      if (!/could not be found|not found in the store|ErrorFolderNotFound/i.test(String(e.fault || e.message))) throw e;
    }
    return { primaryBytes, archiveBytes };
  }

  // Archive folder tree with live counts: [{folderId, parentId, name, path, itemCount}]
  // onFolder(folder) fires per folder as found, so callers can persist
  // incrementally — an interrupted walk keeps everything discovered so far.
  async folderTree(upn, onProgress, signal = null, onFolder = null) {
    const tree = [];
    const push = f => { tree.push(f); if (onFolder) onFolder(f); };
    const walk = async (folderRef, parentId, name, path) => {
      let offset = 0;
      for (;;) {
        const body = `<m:FindFolder Traversal="Shallow">
  <m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>
  <m:IndexedPageFolderView MaxEntriesReturned="100" Offset="${offset}" BaseOffset="0"/>
  <m:ParentFolderIds>${folderRef}</m:ParentFolderIds>
</m:FindFolder>`;
        const rm = this.resp(await this.call(upn, body, 10, signal), 'FindFolder');
        const rf = rm.RootFolder;
        const folders = folderList(rf.Folders);
        for (const f of folders) {
          const childPath = path ? path + '/' + f.DisplayName : f.DisplayName;
          push({ folderId: f.FolderId['@Id'], parentId, name: f.DisplayName, path: childPath, itemCount: parseInt(f.TotalCount || '0', 10) });
          await walk(`<t:FolderId Id="${xmlEscape(f.FolderId['@Id'])}"/>`, f.FolderId['@Id'], f.DisplayName, childPath);
        }
        if (onProgress) onProgress(tree.length, path);
        const more = String(rf['@IncludesLastItemInRange']).toLowerCase() === 'false';
        if (!more || folders.length === 0) break;
        offset += folders.length;
      }
    };
    // The archive root itself holds items too, so include it as a syncable
    // folder (syncFolderItems maps this id to the DistinguishedFolderId).
    push({ folderId: 'archivemsgfolderroot', parentId: null, name: 'Archive root', path: 'Archive root', itemCount: 0 });
    await walk('<t:DistinguishedFolderId Id="archivemsgfolderroot"/>', 'archivemsgfolderroot', 'Archive root', 'Archive root');
    return tree;
  }

  // Delta folder-hierarchy sync: returns only folders created/updated/deleted
  // since syncState. First call (no state) performs a full hierarchy sync.
  // { syncState, changed: [{folderId, parentId, name, itemCount}], deleted: [folderId] }
  async syncFolderHierarchy(upn, syncState, signal = null, onProgress = null, onFolder = null) {
    const changed = [], deleted = [];
    let state = syncState || '';
    for (;;) {
      const body = `<m:SyncFolderHierarchy>
  <m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>
  <m:SyncFolderId><t:DistinguishedFolderId Id="archivemsgfolderroot"/></m:SyncFolderId>
  ${state ? `<m:SyncState>${xmlEscape(state)}</m:SyncState>` : ''}
  <m:MaxChangesReturned>512</m:MaxChangesReturned>
</m:SyncFolderHierarchy>`;
      const rm = this.resp(await this.call(upn, body, 10, signal), 'SyncFolderHierarchy');
      const ch = rm.Changes || {};
      // EWS tags are Create/Update/Delete (namespace stripped by the parser).
      // Folders arrive as typed children (Folder, CalendarFolder, …) inside each.
      for (const tag of ['Create', 'Update']) {
        const holder = ch[tag];
        const list = holder ? folderList(holder.Folders || holder) : [];
        for (const f of list) {
          const row = {
            folderId: f.FolderId['@Id'],
            parentId: f.ParentFolderId ? f.ParentFolderId['@Id'] : 'archivemsgfolderroot',
            name: f.DisplayName,
            itemCount: parseInt(f.TotalCount || '0', 10)
          };
          changed.push(row);
          if (onFolder) onFolder(row);
        }
      }
      const delHolder = ch.Delete;
      const delRaw = delHolder ? Object.values(delHolder).flat() : [];
      for (const f of delRaw) if (f && f['@Id']) deleted.push(f['@Id']);
      state = rm.SyncState || state;
      if (onProgress) onProgress(changed.length + deleted.length);
      const more = String(rm['@IncludesLastItemInRange']).toLowerCase() === 'false';
      if (!more) break;
    }
    return { syncState: state, changed, deleted };
  }

  // Full/pass sync of a folder. Returns { syncState, ids: [...], deleted: [...] }.
  async syncFolderItems(upn, folderId, syncState, signal = null) {
    const ids = [], deleted = [];
    let state = syncState || '';
    for (;;) {
      const fid = folderId === 'archivemsgfolderroot'
        ? '<t:DistinguishedFolderId Id="archivemsgfolderroot"/>'
        : `<t:FolderId Id="${xmlEscape(folderId)}"/>`;
      const body = `<m:SyncFolderItems>
  <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
  <m:SyncFolderId>${fid}</m:SyncFolderId>
  ${state ? `<m:SyncState>${xmlEscape(state)}</m:SyncState>` : ''}
  <m:MaxChangesReturned>512</m:MaxChangesReturned>
</m:SyncFolderItems>`;
      const rm = this.resp(await this.call(upn, body, 10, signal), 'SyncFolderItems');
      const ch = rm.Changes || {};
      // EWS tags are Create/Update/Delete; each holds typed item children
      // (Message, MeetingRequest, …) — flatten any object carrying an ItemId.
      const itemList = holder => {
        if (!holder) return [];
        const out = [];
        for (const v of Object.values(holder)) {
          for (const m of Array.isArray(v) ? v : [v]) if (m && m.ItemId) out.push(m);
        }
        return out;
      };
      for (const m of [...itemList(ch.Create), ...itemList(ch.Update)]) ids.push({ id: m.ItemId['@Id'], changeKey: m.ItemId['@ChangeKey'] });
      // Delete holds bare ItemId elements, not wrapped items.
      const delRaw = ch.Delete ? Object.values(ch.Delete).flat() : [];
      for (const d of delRaw) if (d && d['@Id']) deleted.push(d['@Id']);
      state = rm.SyncState || state;
      const more = String(rm['@IncludesLastItemInRange']).toLowerCase() === 'false';
      if (!more) break;
    }
    return { syncState: state, ids, deleted };
  }

  // ConvertId between id formats (Graph folder/message ids are REST ids).
  // Returns Map sourceId -> converted id; ids that fail to convert are absent.
  // Response messages come back in request order, so mapping is positional.
  async convertIds(upn, ids, sourceFormat, destFormat, signal = null) {
    const out = new Map();
    const list = [...ids];
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const body = `<m:ConvertId DestinationFormat="${destFormat}">
  <m:SourceIds>${chunk.map(id => `<t:AlternateId Format="${sourceFormat}" Id="${xmlEscape(id)}" Mailbox="${xmlEscape(upn)}"/>`).join('')}</m:SourceIds>
</m:ConvertId>`;
      const rms = (await this.call(upn, body, 10, signal)).ConvertIdResponse.ResponseMessages.ConvertIdResponseMessage;
      const arr = Array.isArray(rms) ? rms : [rms];
      for (let j = 0; j < arr.length && j < chunk.length; j++) {
        const rm = arr[j];
        const cls = rm && (rm.ResponseClass || rm['@ResponseClass']);
        if (cls === 'Success' && rm.AlternateId && rm.AlternateId['@Id']) out.set(chunk[j], rm.AlternateId['@Id']);
      }
    }
    return out;
  }

  async convertRestIds(upn, restIds, graph, signal = null) {
    // This tenant rejects Format="RestId" in ConvertId (ErrorInvalidRequest), so
    // bridge via PR_ENTRYID: Graph exposes it base64-encoded (Binary 0x0FFF) and
    // ConvertId Format="EntryId" (base64) -> EwsId works.
    const entryIds = new Map(); // restId -> base64 PR_ENTRYID
    for (const id of restIds) {
      const b64 = await graph.folderEntryId(upn, id, signal);
      if (b64) entryIds.set(id, b64);
    }
    const byEntry = await this.convertIds(upn, [...entryIds.values()], 'EntryId', 'EwsId', signal);
    const out = new Map();
    for (const [restId, entry] of entryIds) if (byEntry.has(entry)) out.set(restId, byEntry.get(entry));
    return out;
  }

  // CreateItem SaveOnly: unlike Graph MIME import (which always creates a draft
  // with receivedDateTime=now), EWS honors MAPI properties on save —
  // PR_MESSAGE_FLAGS=1 (MSGFLAG_READ, no UNSENT) keeps it out of Drafts and
  // PR_MESSAGE_DELIVERY_TIME/PR_CLIENT_SUBMIT_TIME set received/sent dates.
  // Returns the created item's EWS id.
  async uploadMessage(upn, ewsFolderId, mimeBuffer, receivedAtIso, signal = null) {
    let dt = null;
    try { dt = receivedAtIso ? new Date(receivedAtIso).toISOString() : null; } catch { }
    const timeProps = dt
      ? `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x0E06" PropertyType="SystemTime"/><t:Value>${dt}</t:Value></t:ExtendedProperty>` +
        `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x0039" PropertyType="SystemTime"/><t:Value>${dt}</t:Value></t:ExtendedProperty>`
      : '';
    const body = `<m:CreateItem MessageDisposition="SaveOnly">
  <m:SavedItemFolderId><t:FolderId Id="${xmlEscape(ewsFolderId)}"/></m:SavedItemFolderId>
  <m:Items><t:Message>
    <t:MimeContent>${mimeBuffer.toString('base64')}</t:MimeContent>
    <t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x0E07" PropertyType="Integer"/><t:Value>1</t:Value></t:ExtendedProperty>
    ${timeProps}
  </t:Message></m:Items>
</m:CreateItem>`;
    const rm = this.resp(await this.call(upn, body, 10, signal), 'CreateItem');
    const msgs = rm.Items ? (Array.isArray(rm.Items.Message) ? rm.Items.Message : [rm.Items.Message]) : [];
    if (!msgs[0] || !msgs[0].ItemId) throw new Error('EWS CreateItem returned no item id');
    return msgs[0].ItemId['@Id'];
  }

  // Move an item (by EWS id) to Deleted Items. Used by compare undo: uploaded
  // items are tracked by their EWS id (ConvertId to RestId is tenant-blocked).
  async moveToDeletedItems(upn, ewsItemId, signal = null) {
    const body = `<m:MoveItem>
  <m:ToFolderId><t:DistinguishedFolderId Id="deleteditems"/></m:ToFolderId>
  <m:ItemIds><t:ItemId Id="${xmlEscape(ewsItemId)}"/></m:ItemIds>
</m:MoveItem>`;
    this.resp(await this.call(upn, body, 10, signal), 'MoveItem');
    return true;
  }

  async getItemMime(upn, itemId, changeKey, signal = null) {
    const body = `<m:GetItem>
  <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:IncludeMimeContent>true</t:IncludeMimeContent></m:ItemShape>
  <m:ItemIds><t:ItemId Id="${xmlEscape(itemId)}" ${changeKey ? `ChangeKey="${xmlEscape(changeKey)}"` : ''}/></m:ItemIds>
</m:GetItem>`;
    let rm;
    try {
      rm = this.resp(await this.call(upn, body, 10, signal), 'GetItem');
    } catch (e) {
      // Item vanished server-side (moved/deleted or archived elsewhere): flag it
      // so the caller drops the row instead of retrying forever.
      if (/ErrorItemNotFound|not found in the store|ErrorChangeKeyRequired/i.test(String(e.fault || e.message))) {
        const err = new Error(`EWS item gone: ${e.fault || e.message}`);
        err.gone = true;
        throw err;
      }
      throw e;
    }
    const items = rm.Items ? (Array.isArray(rm.Items.Message) ? rm.Items.Message : [rm.Items.Message]) : [];
    if (!items[0]) {
      const err = new Error('EWS GetItem returned no item');
      err.gone = true;
      throw err;
    }
    const mc = items[0].MimeContent;
    const b64 = typeof mc === 'string' ? mc : (mc && mc['#text']) || '';
    return Buffer.from(b64, 'base64');
  }
}

module.exports = { EwsClient };
