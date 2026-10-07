// SQLite state: mailboxes, folders, per-item checkpoints, events, jobs.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'state.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mailboxes (
        upn TEXT PRIMARY KEY,
        type TEXT DEFAULT 'user',
        status TEXT DEFAULT 'pending',
        primaryBytes INTEGER DEFAULT 0,
        archiveBytes INTEGER DEFAULT 0,
        verifyOk INTEGER,
        verifyAt TEXT,
        verifyReport TEXT,
        pstStatus TEXT DEFAULT '',
        lastError TEXT,
        lastRunAt TEXT,
        addedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS folders (
        upn TEXT NOT NULL, scope TEXT NOT NULL, folderId TEXT NOT NULL,
        parentId TEXT, name TEXT, path TEXT, itemCount INTEGER DEFAULT 0,
        deltaToken TEXT, syncState TEXT, syncedAt TEXT,
        PRIMARY KEY (upn, scope, folderId)
      );
      CREATE TABLE IF NOT EXISTS items (
        upn TEXT NOT NULL, scope TEXT NOT NULL, folderId TEXT NOT NULL, itemId TEXT NOT NULL,
        subject TEXT, receivedAt TEXT, size INTEGER DEFAULT 0, fileId TEXT,
        status TEXT DEFAULT 'done', lastError TEXT, attempts INTEGER DEFAULT 0, updatedAt TEXT,
        PRIMARY KEY (upn, scope, folderId, itemId)
      );
      CREATE INDEX IF NOT EXISTS idx_items_status ON items(upn, status);
      -- sha256 added later: migrate existing DBs.

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, level TEXT NOT NULL, mailbox TEXT NOT NULL DEFAULT '', message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_mailbox ON events(mailbox, id);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
        total INTEGER DEFAULT 0, done INTEGER DEFAULT 0, detail TEXT DEFAULT '',
        startedAt TEXT, finishedAt TEXT
      );
    `);
    for (const col of ['serverPrimaryBytes INTEGER', 'serverArchiveBytes INTEGER', 'serverSizeAt TEXT', 'hasArchive INTEGER',
      'ewsPrimaryBytes INTEGER', 'ewsArchiveBytes INTEGER', 'sizeSource TEXT', 'autoExpandingArchive INTEGER']) {
      try { this.db.exec(`ALTER TABLE mailboxes ADD COLUMN ${col}`); } catch { }
    }
    // One-time backfill: pre-existing server sizes came from EWS scans.
    this.db.prepare(`UPDATE mailboxes SET ewsPrimaryBytes=serverPrimaryBytes, ewsArchiveBytes=serverArchiveBytes,
      sizeSource='ews' WHERE sizeSource IS NULL AND serverSizeAt IS NOT NULL`).run();
    try { this.db.exec('ALTER TABLE folders ADD COLUMN diskPath TEXT'); } catch { }
    // Items the server counts in TotalCount but no listing ever returns
    // (hidden/associated messages). Recorded per folder so a count gap from
    // these doesn't force a full re-list on every run.
    try { this.db.exec('ALTER TABLE folders ADD COLUMN hiddenCount INTEGER NOT NULL DEFAULT 0'); } catch { }
    try { this.db.exec('ALTER TABLE items ADD COLUMN sha256 TEXT'); } catch { }
    // Last requested backup scope ('archive' for archive-only runs, else 'all'):
    // auto-resume replays this instead of silently widening an archive-only run
    // into a full primary+archive backup.
    try { this.db.exec(`ALTER TABLE mailboxes ADD COLUMN backupScope TEXT`); } catch { }
    // EWS SyncFolderHierarchy cursor for the archive: lets a run validate only
    // folder changes instead of re-walking the whole tree from scratch.
    try { this.db.exec(`ALTER TABLE mailboxes ADD COLUMN archiveHierarchyState TEXT`); } catch { }
    // EXO compliance-search export: one row per (upn, date chunk). Chunk
    // identity is stable across restarts; 'done' rows with the PST on disk are
    // never re-exported.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exo_exports (
        upn TEXT NOT NULL, chunkFrom TEXT NOT NULL, chunkTo TEXT NOT NULL,
        searchName TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        pstPath TEXT, bytes INTEGER DEFAULT 0, items INTEGER DEFAULT 0,
        error TEXT, attempts INTEGER DEFAULT 0,
        startedAt TEXT, finishedAt TEXT,
        PRIMARY KEY (upn, chunkFrom, chunkTo)
      );
      CREATE INDEX IF NOT EXISTS idx_exo_exports_upn ON exo_exports(upn, status);
    `);
    // Ingest tracking: how much of a finished chunk's PST made it into the
    // browsable backup store (data/store + items rows).
    try { this.db.exec('ALTER TABLE exo_exports ADD COLUMN ingestedItems INTEGER NOT NULL DEFAULT 0'); } catch { }
    try { this.db.exec('ALTER TABLE exo_exports ADD COLUMN ingestedBytes INTEGER NOT NULL DEFAULT 0'); } catch { }
    // Copy/move jobs: per-item upload record for the integrity report.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS copy_items (
        jobId INTEGER NOT NULL, srcUpn TEXT NOT NULL, dstUpn TEXT NOT NULL,
        scope TEXT, folderPath TEXT, itemId TEXT NOT NULL, dstMessageId TEXT,
        size INTEGER DEFAULT 0, sha256 TEXT, verified INTEGER DEFAULT 0,
        note TEXT, createdAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_copy_items_job ON copy_items(jobId);
    `);
    // Compare page transfer history: one row per completed copy/move/folder/undo action.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS compare_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, kind TEXT NOT NULL, direction TEXT, mode TEXT,
        srcUpn TEXT, dstUpn TEXT, dstScope TEXT, srcName TEXT, dstName TEXT,
        itemsTotal INTEGER DEFAULT 0, done INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0, folders INTEGER DEFAULT 0, stopped INTEGER DEFAULT 0, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_compare_log_upns ON compare_log(srcUpn, dstUpn);
    `);
    // --- Archive-upgrade schema (additive; pre-migration backup taken once) ---
    const dbFile = path.join(dataDir, 'state.db');
    const bakFile = path.join(dataDir, 'state.db.bak-prearchive');
    try {
      if (fs.existsSync(dbFile) && !fs.existsSync(bakFile)) fs.copyFileSync(dbFile, bakFile);
    } catch { }
    // Per physical archive partition (main + each auxiliary MBX discovered via
    // Graph IE redirects or derived from EXO totals). Bytes are only ever real
    // measured/reported numbers — never estimates.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_partitions (
        upn TEXT NOT NULL, partitionId TEXT NOT NULL,
        partitionType TEXT NOT NULL DEFAULT 'main',
        discoveredVia TEXT, redirectFrom TEXT,
        itemCount INTEGER, logicalBytes INTEGER,
        backedUpItems INTEGER NOT NULL DEFAULT 0, backedUpBytes INTEGER NOT NULL DEFAULT 0,
        status TEXT DEFAULT 'discovered',
        firstSeenAt TEXT, lastSeenAt TEXT,
        PRIMARY KEY (upn, partitionId)
      );
      -- Backup generations: one row per run per mailbox.
      CREATE TABLE IF NOT EXISTS backup_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upn TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'all', provider TEXT,
        startedAt TEXT, finishedAt TEXT,
        itemsDiscovered INTEGER DEFAULT 0, itemsNew INTEGER DEFAULT 0,
        itemsChanged INTEGER DEFAULT 0, itemsDeleted INTEGER DEFAULT 0,
        itemsFailed INTEGER DEFAULT 0, bytesDownloaded INTEGER DEFAULT 0,
        serverBytes INTEGER, coverageState TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_backup_runs_upn ON backup_runs(upn, id);
    `);
    for (const col of ['coverageState TEXT', 'coverageCheckedAt TEXT', 'archiveMailboxId TEXT',
      'serverPrimaryItems INTEGER', 'serverArchiveItems INTEGER']) {
      try { this.db.exec(`ALTER TABLE mailboxes ADD COLUMN ${col}`); } catch { }
    }
    for (const col of [`format TEXT NOT NULL DEFAULT 'eml'`, 'sourceApi TEXT', 'physicalMailboxId TEXT',
      'deletedFromSourceAt TEXT', 'verifiedAt TEXT', 'verifyMethod TEXT', 'sender TEXT']) {
      try { this.db.exec(`ALTER TABLE items ADD COLUMN ${col}`); } catch { }
    }
    for (const col of ['physicalMailboxId TEXT', 'isExpanded INTEGER NOT NULL DEFAULT 0']) {
      try { this.db.exec(`ALTER TABLE folders ADD COLUMN ${col}`); } catch { }
    }
    // Graph Mailbox IE archive hierarchy delta cursor (beta provider).
    try { this.db.exec('ALTER TABLE mailboxes ADD COLUMN archiveIeState TEXT'); } catch { }
    // Per-mailbox job attribution (dedupe run history etc.).
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN upn TEXT'); } catch { }
    this._snapshotBusy = false;
    this._snapshotTimer = null;
    this._insEvent = this.db.prepare('INSERT INTO events(ts,level,mailbox,message) VALUES (?,?,?,?)');
    this._insJob = this.db.prepare('INSERT INTO jobs(kind,status,total,done,detail,startedAt,upn) VALUES (?,?,?,?,?,?,?)');
    this._setMailbox = this.db.prepare(`INSERT INTO mailboxes(upn,type,status,addedAt) VALUES (@upn,@type,'pending',@ts)
      ON CONFLICT(upn) DO UPDATE SET type=excluded.type`);
    this._patchMailbox = this.db.prepare('UPDATE mailboxes SET lastRunAt=? WHERE upn=?');
  }

  log(level, mailbox, message) {
    this._insEvent.run(new Date().toISOString(), level, mailbox || '', String(message).slice(0, 2000));
  }
  logTail(n) { return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(n).reverse(); }
  mailboxEvents(upn, n) { return this.db.prepare('SELECT * FROM events WHERE mailbox=? ORDER BY id DESC LIMIT ?').all(upn, n).reverse(); }
  clearEvents(upn) { return this.db.prepare('DELETE FROM events WHERE mailbox=?').run(upn).changes; }
  clearAllEvents() { return this.db.prepare('DELETE FROM events').run().changes; }
  pruneEvents(keep = 100000) {
    return this.db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id) FROM events) - ?').run(keep).changes;
  }

  tx(fn) { return this.db.transaction(fn); }

  aggregates() {
    const r = this.db.prepare(`SELECT
      COUNT(*) total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN status IN ('partial','syncing') THEN 1 ELSE 0 END) partial,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
      COALESCE(SUM(primaryBytes),0) primaryBytes, COALESCE(SUM(archiveBytes),0) archiveBytes
      FROM mailboxes`).get();
    return { total: r.total || 0, done: r.done || 0, partial: r.partial || 0, errors: r.errors || 0, pending: r.pending || 0, primaryBytes: r.primaryBytes || 0, archiveBytes: r.archiveBytes || 0 };
  }

  createJob(kind, total = 0, upn = '') {
    const id = this._insJob.run(kind, 'running', total, 0, '', new Date().toISOString(), upn).lastInsertRowid;
    return Number(id);
  }
  updateJob(id, patch) {
    const cur = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!cur) return;
    const p = { ...cur, ...patch };
    this.db.transaction(() => {
      this.db.prepare('UPDATE jobs SET status=?, total=?, done=?, detail=?, finishedAt=? WHERE id=?')
        .run(p.status, p.total, p.done, p.detail || '', p.finishedAt || null, id);
    })();
    // Snapshot the DB shortly after each finished job (debounced).
    if (patch.status && patch.status !== 'running') this._scheduleSnapshot();
  }

  // Lightweight disaster-recovery copy of state.db, written next to it.
  snapshot() {
    if (this._snapshotBusy) return false;
    this._snapshotBusy = true;
    try {
      this.db.prepare('VACUUM INTO ?').run(path.join(this.dataDir, 'state-backup.db'));
      return true;
    } catch { return false; }
    finally { this._snapshotBusy = false; }
  }
  _scheduleSnapshot() {
    if (this._snapshotTimer) return;
    this._snapshotTimer = setTimeout(() => { this._snapshotTimer = null; this.snapshot(); }, 5000);
    if (this._snapshotTimer.unref) this._snapshotTimer.unref();
  }
  listJobs() { return this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 20').all(); }
  pruneJobs(keep = 500) {
    return this.db.prepare('DELETE FROM jobs WHERE id < (SELECT MAX(id) FROM jobs) - ?').run(keep).changes;
  }
  // Startup crash recovery: jobs that never saw a clean shutdown stay 'running'
  // forever, so mark them interrupted. A mailbox mid-PST-export when the server
  // died also keeps pstStatus='running' forever — reset it too (the orphaned
  // PowerShell/Outlook process dies with its own watchdog or is re-run safely;
  // the export manifest makes re-runs resume).
  reconcileJobs() {
    const jobs = this.db.prepare(`UPDATE jobs SET status='interrupted', finishedAt=? WHERE status='running'`)
      .run(new Date().toISOString()).changes;
    const psts = this.db.prepare(`UPDATE mailboxes SET pstStatus='interrupted (server restarted) — safe to re-run' WHERE pstStatus='running'`)
      .run().changes;
    return jobs + psts;
  }

  upsertMailbox(upn, type = 'user') { this._setMailbox.run({ upn, type, ts: new Date().toISOString() }); }
  listMailboxes() { return this.db.prepare('SELECT * FROM mailboxes ORDER BY upn').all(); }
  getMailbox(upn) { return this.db.prepare('SELECT * FROM mailboxes WHERE upn=?').get(upn); }
  patchMailboxFields(upn, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE mailboxes SET ${keys.map(k => `${k}=@${k}`).join(',')} WHERE upn=@upn`)
      .run({ ...fields, upn });
    this._patchMailbox.run(new Date().toISOString(), upn);
  }

  upsertFolder(f) {
    this.db.prepare(`INSERT INTO folders(upn,scope,folderId,parentId,name,path,itemCount,deltaToken,syncState,syncedAt,diskPath)
      VALUES (@upn,@scope,@folderId,@parentId,@name,@path,@itemCount,@deltaToken,@syncState,@syncedAt,@diskPath)
      ON CONFLICT(upn,scope,folderId) DO UPDATE SET
        parentId=excluded.parentId, name=excluded.name, path=excluded.path, itemCount=excluded.itemCount,
        deltaToken=COALESCE(excluded.deltaToken, folders.deltaToken),
        syncState=COALESCE(excluded.syncState, folders.syncState),
        diskPath=COALESCE(excluded.diskPath, folders.diskPath),
        syncedAt=excluded.syncedAt`)
      .run({ parentId: null, name: '', path: '', itemCount: 0, deltaToken: null, syncState: null, diskPath: null, syncedAt: new Date().toISOString(), ...f });
  }
  setFolderDiskPath(upn, scope, folderId, diskPath) {
    this.db.prepare('UPDATE folders SET diskPath=? WHERE upn=? AND scope=? AND folderId=?').run(diskPath, upn, scope, folderId);
  }
  setFolderHiddenCount(upn, scope, folderId, n) {
    this.db.prepare('UPDATE folders SET hiddenCount=? WHERE upn=? AND scope=? AND folderId=?').run(n, upn, scope, folderId);
  }
  listFolders(upn) { return this.db.prepare('SELECT * FROM folders WHERE upn=? ORDER BY scope, name').all(upn); }
  folderStats(upn) {
    return this.db.prepare(`SELECT f.scope, f.folderId, f.parentId, f.name, f.path, f.itemCount,
        COALESCE(s.cnt,0) AS backedUp, COALESCE(s.bytes,0) AS bytes
      FROM folders f
      LEFT JOIN (SELECT scope, folderId, COUNT(*) cnt, SUM(size) bytes
                 FROM items WHERE upn=? AND status='done' GROUP BY scope, folderId) s
        ON s.scope=f.scope AND s.folderId=f.folderId
      WHERE f.upn=? ORDER BY f.scope, f.path`).all(upn, upn);
  }
  deleteMailboxData(upn, scope) {
    this.db.transaction(() => {
      if (scope === 'primary' || scope === 'archive') {
        this.db.prepare('DELETE FROM items WHERE upn=? AND scope=?').run(upn, scope);
        this.db.prepare('DELETE FROM folders WHERE upn=? AND scope=?').run(upn, scope);
        const byteCol = scope === 'primary' ? 'primaryBytes' : 'archiveBytes';
        const other = this.db.prepare('SELECT COUNT(*) c FROM folders WHERE upn=?').get(upn).c;
        this.db.prepare(`UPDATE mailboxes SET ${byteCol}=0, status=?, lastError=NULL WHERE upn=?`)
          .run(other > 0 ? 'partial' : 'pending', upn);
        return;
      }
      this.db.prepare('DELETE FROM items WHERE upn=?').run(upn);
      this.db.prepare('DELETE FROM folders WHERE upn=?').run(upn);
      this.db.prepare(`UPDATE mailboxes SET status='pending', primaryBytes=0, archiveBytes=0,
          verifyOk=NULL, verifyAt=NULL, verifyReport=NULL, pstStatus='', lastError=NULL WHERE upn=?`).run(upn);
    })();
  }
  getFolder(upn, scope, folderId) { return this.db.prepare('SELECT * FROM folders WHERE upn=? AND scope=? AND folderId=?').get(upn, scope, folderId); }
  deleteFolder(upn, scope, folderId) {
    const folder = this.getFolder(upn, scope, folderId);
    if (!folder) return { removedItems: 0, removedFolders: 0 };
    return this.db.transaction(() => {
      const ids = this.db.prepare(
        `SELECT folderId FROM folders WHERE upn=? AND scope=? AND (path=? OR path LIKE ?)`)
        .all(upn, scope, folder.path, folder.path + '/%').map(r => r.folderId);
      const marks = ids.map(() => '?').join(',');
      const removedItems = this.db.prepare(
        `DELETE FROM items WHERE upn=? AND scope=? AND folderId IN (${marks})`).run(upn, scope, ...ids).changes;
      const removedFolders = this.db.prepare(
        `DELETE FROM folders WHERE upn=? AND scope=? AND folderId IN (${marks})`).run(upn, scope, ...ids).changes;
      const sums = this.db.prepare(
        `SELECT scope, COALESCE(SUM(size),0) b FROM items WHERE upn=? AND status='done' GROUP BY scope`).all(upn);
      const fields = { primaryBytes: 0, archiveBytes: 0 };
      for (const s of sums) fields[s.scope === 'archive' ? 'archiveBytes' : 'primaryBytes'] = s.b;
      const remaining = this.db.prepare('SELECT COUNT(*) c FROM folders WHERE upn=?').get(upn).c;
      fields.status = remaining > 0 ? 'partial' : 'pending';
      this.patchMailboxFields(upn, fields);
      return { removedItems, removedFolders };
    })();
  }

  upsertItem(it) {
    this.db.prepare(`INSERT INTO items(upn,scope,folderId,itemId,subject,receivedAt,size,fileId,status,lastError,attempts,updatedAt,sha256,format,sourceApi,physicalMailboxId,sender)
      VALUES (@upn,@scope,@folderId,@itemId,@subject,@receivedAt,@size,@fileId,@status,@lastError,@attempts,@updatedAt,@sha256,@format,@sourceApi,@physicalMailboxId,@sender)
      ON CONFLICT(upn,scope,folderId,itemId) DO UPDATE SET
        subject=excluded.subject, receivedAt=excluded.receivedAt, size=excluded.size, fileId=excluded.fileId,
        status=excluded.status, lastError=excluded.lastError, attempts=excluded.attempts, updatedAt=excluded.updatedAt,
        sha256=COALESCE(excluded.sha256, items.sha256),
        format=COALESCE(excluded.format, items.format),
        sourceApi=COALESCE(excluded.sourceApi, items.sourceApi),
        physicalMailboxId=COALESCE(excluded.physicalMailboxId, items.physicalMailboxId),
        sender=COALESCE(excluded.sender, items.sender)`)
      .run({ subject: null, receivedAt: null, size: 0, fileId: null, status: 'done', lastError: null, attempts: 0, updatedAt: new Date().toISOString(), sha256: null, format: 'eml', sourceApi: null, physicalMailboxId: null, sender: null, ...it });
  }
  getItem(upn, scope, folderId, itemId) { return this.db.prepare('SELECT * FROM items WHERE upn=? AND scope=? AND folderId=? AND itemId=?').get(upn, scope, folderId, itemId); }
  deleteItem(upn, scope, folderId, itemId) { this.db.prepare('DELETE FROM items WHERE upn=? AND scope=? AND folderId=? AND itemId=?').run(upn, scope, folderId, itemId); }
  countItems(upn, scope, folderId) { return this.db.prepare('SELECT COUNT(*) n FROM items WHERE upn=? AND scope=? AND folderId=?').get(upn, scope, folderId).n; }
  countDoneItems(upn, scope, folderId) { return this.db.prepare(`SELECT COUNT(*) n FROM items WHERE upn=? AND scope=? AND folderId=? AND status IN ('done','deduped')`).get(upn, scope, folderId).n; }
  // Force the next backup of this folder to do a full re-scan instead of an
  // incremental delta — used by verify when stored rows don't match the source.
  clearFolderCursor(upn, scope, folderId) {
    this.db.prepare('UPDATE folders SET deltaToken=NULL, syncState=NULL WHERE upn=? AND scope=? AND folderId=?').run(upn, scope, folderId);
  }
  // Backup semantics: a remote deletion NEVER destroys the local copy — the row
  // is timestamped and the file stays in place. (cfg.pruneDeleted=true keeps the
  // old graveyard/delete mirror for operators who opt in.)
  markItemDeletedFromSource(upn, scope, folderId, itemId) {
    this.db.prepare(`UPDATE items SET deletedFromSourceAt=?, updatedAt=? WHERE upn=? AND scope=? AND folderId=? AND itemId=? AND deletedFromSourceAt IS NULL`)
      .run(new Date().toISOString(), new Date().toISOString(), upn, scope, folderId, itemId);
  }
  clearItemDeletedFromSource(upn, scope, folderId, itemId) {
    this.db.prepare(`UPDATE items SET deletedFromSourceAt=NULL WHERE upn=? AND scope=? AND folderId=? AND itemId=?`).run(upn, scope, folderId, itemId);
  }

  upsertPartition(p) {
    this.db.prepare(`INSERT INTO archive_partitions(upn,partitionId,partitionType,discoveredVia,redirectFrom,itemCount,logicalBytes,status,firstSeenAt,lastSeenAt)
      VALUES (@upn,@partitionId,@partitionType,@discoveredVia,@redirectFrom,@itemCount,@logicalBytes,@status,@ts,@ts)
      ON CONFLICT(upn,partitionId) DO UPDATE SET
        partitionType=excluded.partitionType, discoveredVia=COALESCE(excluded.discoveredVia, archive_partitions.discoveredVia),
        redirectFrom=COALESCE(excluded.redirectFrom, archive_partitions.redirectFrom),
        itemCount=COALESCE(excluded.itemCount, archive_partitions.itemCount),
        logicalBytes=COALESCE(excluded.logicalBytes, archive_partitions.logicalBytes),
        status=excluded.status, lastSeenAt=excluded.lastSeenAt`)
      .run({ partitionType: 'main', discoveredVia: null, redirectFrom: null, itemCount: null, logicalBytes: null, status: 'discovered', ts: new Date().toISOString(), ...p });
  }
  listPartitions(upn) { return this.db.prepare('SELECT * FROM archive_partitions WHERE upn=? ORDER BY partitionType, partitionId').all(upn); }

  createRun(r) {
    return this.db.prepare(`INSERT INTO backup_runs(upn,scope,provider,startedAt,serverBytes) VALUES (@upn,@scope,@provider,@ts,@serverBytes)`)
      .run({ scope: 'all', provider: null, serverBytes: null, ts: new Date().toISOString(), ...r }).lastInsertRowid;
  }
  finishRun(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE backup_runs SET ${keys.map(k => `${k}=@${k}`).join(',')}, finishedAt=@ts WHERE id=@id`)
      .run({ ...fields, ts: new Date().toISOString(), id });
  }
  listRuns(upn, n = 20) { return this.db.prepare('SELECT * FROM backup_runs WHERE upn=? ORDER BY id DESC LIMIT ?').all(upn, n); }

  // After an EWS browse-copy pass (provider='ews'), fold the EWS-namespace
  // archive folders/items into the Graph IE ('ie-') tree by normalized path —
  // one logical tree, each folder holding both .eml.gz (browse) and .fts.gz
  // (restore) rows. EWS rows without an IE counterpart are kept.
  mergeArchiveNamespaces(upn) {
    const norm = p => String(p || '').split('/').map(s => s.trim().replace(/\s+/g, ' ')).join('/');
    const ewsRows = this.db.prepare(`SELECT folderId, path FROM folders WHERE upn=? AND scope='archive' AND folderId NOT LIKE 'ie-%' AND folderId NOT LIKE 'exo%'`).all(upn);
    if (!ewsRows.length) return { movedItems: 0, dropped: 0, kept: 0 };
    const ieByPath = new Map(this.db.prepare(`SELECT folderId, path FROM folders WHERE upn=? AND scope='archive' AND folderId LIKE 'ie-%'`).all(upn).map(r => [norm(r.path), r.folderId]));
    let movedItems = 0, dropped = 0, kept = 0;
    this.db.transaction(() => {
      for (const r of ewsRows) {
        const ie = ieByPath.get(norm(r.path));
        if (ie) {
          movedItems += this.db.prepare(`UPDATE items SET folderId=? WHERE upn=? AND scope='archive' AND folderId=?`).run(ie, upn, r.folderId).changes;
          this.db.prepare(`DELETE FROM folders WHERE upn=? AND scope='archive' AND folderId=?`).run(upn, r.folderId);
          dropped++;
        } else kept++;
      }
    })();
    return { movedItems, dropped, kept };
  }

  // 'deleted' (remote-deletion mirror) and 'deduped' (duplicate moved aside) rows are not pending work.
  pendingTotal(upn) { return this.db.prepare(`SELECT COUNT(*) n FROM items WHERE upn=? AND status NOT IN ('done','deleted','deduped')`).get(upn).n; }
  topErrors(upn, limit = 5) {
    return this.db.prepare(`SELECT COUNT(*) n, lastError FROM items WHERE upn=? AND status NOT IN ('done','deleted','deduped') AND lastError IS NOT NULL
      GROUP BY lastError ORDER BY n DESC LIMIT ?`).all(upn, limit);
  }
  randomItems(upn, limit) {
    // ORDER BY RANDOM() sorts the whole table; with many rows pick random
    // rowid offsets instead and top up if some offsets miss (gaps, non-done rows).
    const total = this.db.prepare(`SELECT COUNT(*) n FROM items WHERE upn=? AND status='done' AND fileId IS NOT NULL`).get(upn).n;
    if (total <= limit * 4 || total === 0) {
      return this.db.prepare(`SELECT * FROM items WHERE upn=? AND status='done' AND fileId IS NOT NULL ORDER BY RANDOM() LIMIT ?`).all(upn, limit);
    }
    const range = this.db.prepare(`SELECT MIN(rowid) lo, MAX(rowid) hi FROM items WHERE upn=? AND status='done' AND fileId IS NOT NULL`).get(upn);
    const seen = new Set(), out = [];
    for (let tries = 0; tries < limit * 10 && out.length < limit; tries++) {
      const rid = range.lo + Math.floor(Math.random() * (range.hi - range.lo + 1));
      if (seen.has(rid)) continue;
      seen.add(rid);
      const row = this.db.prepare(`SELECT * FROM items WHERE rowid=? AND upn=? AND status='done' AND fileId IS NOT NULL`).get(rid, upn);
      if (row) out.push(row);
    }
    if (out.length < limit) {
      // Sparse rowids: top up with a plain random pick of whatever is missing.
      const keys = new Set(out.map(r => r.folderId + '|' + r.itemId));
      const extra = this.db.prepare(`SELECT * FROM items WHERE upn=? AND status='done' AND fileId IS NOT NULL ORDER BY RANDOM() LIMIT ?`).all(upn, limit);
      for (const row of extra) {
        if (out.length >= limit) break;
        const k = row.folderId + '|' + row.itemId;
        if (!keys.has(k)) { keys.add(k); out.push(row); }
      }
    }
    return out;
  }
  pendingItems(upn, scope, folderId) { return this.db.prepare(`SELECT itemId FROM items WHERE upn=? AND scope=? AND folderId=? AND status NOT IN ('done','failed','deleted')`).all(upn, scope, folderId); }
  markItemFailed(upn, scope, folderId, itemId, lastError) {
    this.db.prepare(`UPDATE items SET status='failed', lastError=?, updatedAt=? WHERE upn=? AND scope=? AND folderId=? AND itemId=?`)
      .run(String(lastError || '').slice(0, 500) || null, new Date().toISOString(), upn, scope, folderId, itemId);
  }
  countFailed(upn) { return this.db.prepare(`SELECT COUNT(*) n FROM items WHERE upn=? AND status='failed'`).get(upn).n; }
  listItems(upn, scope, folderId, limit = 500) {
    return this.db.prepare(`SELECT itemId, fileId, subject, sender, receivedAt, size, status FROM items
      WHERE upn=? AND scope=? AND folderId=? AND status='done' AND fileId IS NOT NULL
      ORDER BY receivedAt DESC LIMIT ?`).all(upn, scope, folderId, limit);
  }
  listItemsAll(upn, scope, folderId) {
    return this.db.prepare(`SELECT itemId, fileId, subject, sender, receivedAt, size, sha256, status FROM items
      WHERE upn=? AND scope=? AND folderId=? AND status='done' AND fileId IS NOT NULL`).all(upn, scope, folderId);
  }
  // Items whose remote id list no longer contains them are removed during sync.
  folderItemIds(upn, scope, folderId) {
    return this.db.prepare('SELECT itemId, fileId, status FROM items WHERE upn=? AND scope=? AND folderId=?').all(upn, scope, folderId);
  }

  // ---------- EXO compliance-search export ----------
  planChunk(upn, chunkFrom, chunkTo, searchName) {
    this.db.prepare(`INSERT INTO exo_exports(upn,chunkFrom,chunkTo,searchName) VALUES (?,?,?,?)
      ON CONFLICT(upn,chunkFrom,chunkTo) DO NOTHING`).run(upn, chunkFrom, chunkTo, searchName);
  }
  getChunk(upn, chunkFrom, chunkTo) {
    return this.db.prepare('SELECT * FROM exo_exports WHERE upn=? AND chunkFrom=? AND chunkTo=?').get(upn, chunkFrom, chunkTo);
  }
  chunkByName(searchName) { return this.db.prepare('SELECT * FROM exo_exports WHERE searchName=?').get(searchName); }
  markChunk(upn, chunkFrom, chunkTo, patch) {
    const cur = this.getChunk(upn, chunkFrom, chunkTo);
    if (!cur) return;
    const p = { ...cur, ...patch };
    this.db.prepare(`UPDATE exo_exports SET status=?, pstPath=?, bytes=?, items=?, error=?, attempts=?, startedAt=?, finishedAt=?, ingestedItems=?, ingestedBytes=?
      WHERE upn=? AND chunkFrom=? AND chunkTo=?`)
      .run(p.status, p.pstPath, p.bytes, p.items, p.error, p.attempts, p.startedAt, p.finishedAt,
        p.ingestedItems || 0, p.ingestedBytes || 0, upn, chunkFrom, chunkTo);
  }
  exoChunks(upn) { return this.db.prepare('SELECT * FROM exo_exports WHERE upn=? ORDER BY chunkFrom').all(upn); }
  exoOpenChunks() { return this.db.prepare(`SELECT * FROM exo_exports WHERE status != 'done' ORDER BY upn, chunkFrom`).all(); }
  exoExportStats() {
    return this.db.prepare(`SELECT COUNT(*) chunksTotal,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) chunksDone,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) chunksFailed,
      COALESCE(SUM(CASE WHEN status='done' THEN bytes ELSE 0 END),0) bytesDone,
      COALESCE(SUM(ingestedItems),0) itemsIngested,
      COALESCE(SUM(ingestedBytes),0) bytesIngested
      FROM exo_exports`).get();
  }
  exoExportBytesByUpn() {
    const rows = this.db.prepare(`SELECT upn, COALESCE(SUM(bytes),0) b FROM exo_exports WHERE status='done' GROUP BY upn`).all();
    return Object.fromEntries(rows.map(r => [r.upn, r.b]));
  }
  deleteExoExport(upn) {
    return this.db.prepare('DELETE FROM exo_exports WHERE upn=?').run(upn).changes;
  }

  // ---------- Copy/move ----------
  addCopyItem(row) {
    this.db.prepare(`INSERT INTO copy_items(jobId,srcUpn,dstUpn,scope,folderPath,itemId,dstMessageId,size,sha256,verified,note,createdAt)
      VALUES (@jobId,@srcUpn,@dstUpn,@scope,@folderPath,@itemId,@dstMessageId,@size,@sha256,@verified,@note,@createdAt)`)
      .run({ scope: null, folderPath: null, dstMessageId: null, size: 0, sha256: null, verified: 0, note: null, createdAt: new Date().toISOString(), ...row });
  }
  addCompareLog(r) {
    this.db.prepare(`INSERT INTO compare_log(ts,kind,direction,mode,srcUpn,dstUpn,dstScope,srcName,dstName,itemsTotal,done,skipped,failed,folders,stopped,detail)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.ts || new Date().toISOString(), r.kind, r.direction || null, r.mode || null,
        r.srcUpn || null, r.dstUpn || null, r.dstScope || null, r.srcName || null, r.dstName || null,
        r.itemsTotal || 0, r.done || 0, r.skipped || 0, r.failed || 0, r.folders || 0, r.stopped ? 1 : 0, r.detail || null);
  }
  compareHistory(upn, limit = 200) {
    if (upn) return this.db.prepare('SELECT * FROM compare_log WHERE srcUpn=? OR dstUpn=? ORDER BY id DESC LIMIT ?').all(upn, upn, limit);
    return this.db.prepare('SELECT * FROM compare_log ORDER BY id DESC LIMIT ?').all(limit);
  }
  copyReport(jobId) {
    const totals = this.db.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN dstMessageId IS NOT NULL THEN 1 ELSE 0 END) uploaded,
        SUM(verified) verified,
        SUM(CASE WHEN note LIKE 'fail:%' THEN 1 ELSE 0 END) failed,
        COALESCE(SUM(size),0) bytes
      FROM copy_items WHERE jobId=?`).get(jobId);
    const failures = this.db.prepare(`SELECT folderPath, itemId, note FROM copy_items WHERE jobId=? AND note LIKE 'fail:%' LIMIT 50`).all(jobId);
    const mismatches = this.db.prepare(`SELECT folderPath, itemId, note FROM copy_items WHERE jobId=? AND note LIKE 'verify:%' LIMIT 50`).all(jobId);
    return { ...totals, failures, mismatches };
  }
  // Source items selected for a copy: done rows with files, joined to folder paths.
  copyableItems(upn, folderKeys) {
    const rows = this.db.prepare(`SELECT i.upn, i.scope, i.folderId, i.itemId, i.fileId, i.size, i.sha256, i.subject, i.receivedAt,
        f.path AS folderPath, f.name AS folderName
      FROM items i JOIN folders f ON f.upn=i.upn AND f.scope=i.scope AND f.folderId=i.folderId
      WHERE i.upn=? AND i.status='done' AND i.fileId IS NOT NULL`).all(upn);
    if (!folderKeys || !folderKeys.length) return rows;
    const want = new Set(folderKeys);
    return rows.filter(r => want.has(r.scope + ':' + r.folderId));
  }

  // ---------- Dedupe ----------
  // Duplicate groups within one mailbox+scope, keyed by content hash. The
  // canonical (kept) copy is chosen in JS — folder preference isn't SQL-able.
  duplicateGroups(upn) {
    return this.db.prepare(`SELECT i.scope, i.sha256, COUNT(*) n, COALESCE(SUM(i.size),0) bytes
      FROM items i
      WHERE i.upn=? AND i.status='done' AND i.sha256 IS NOT NULL
      GROUP BY i.scope, i.sha256 HAVING COUNT(*) > 1
      ORDER BY bytes DESC`).all(upn);
  }
  itemsByHash(upn, scope, sha256) {
    return this.db.prepare(`SELECT i.*, f.path AS folderPath, f.name AS folderName
      FROM items i JOIN folders f ON f.upn=i.upn AND f.scope=i.scope AND f.folderId=i.folderId
      WHERE i.upn=? AND i.scope=? AND i.sha256=? AND i.status='done'`).all(upn, scope, sha256);
  }
  setItemStatus(upn, scope, folderId, itemId, status) {
    this.db.prepare('UPDATE items SET status=?, updatedAt=? WHERE upn=? AND scope=? AND folderId=? AND itemId=?')
      .run(status, new Date().toISOString(), upn, scope, folderId, itemId);
  }
  // Exact byte recompute from done rows (mirrors engine._updateBytes).
  recomputeMailboxBytes(upn) {
    const sums = this.db.prepare(
      `SELECT scope, COALESCE(SUM(size),0) b FROM items WHERE upn=? AND status='done' GROUP BY scope`).all(upn);
    const fields = { primaryBytes: 0, archiveBytes: 0 };
    for (const s of sums) fields[s.scope === 'archive' ? 'archiveBytes' : 'primaryBytes'] = s.b;
    this.patchMailboxFields(upn, fields);
  }
}

module.exports = { Store };
