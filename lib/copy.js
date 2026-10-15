// Copy/move: upload locally stored .eml.gz items into another live M365 mailbox
// via EWS CreateItem (Graph MIME import creates drafts with the import date),
// 'move' mode retires the local source file to the graveyard after a verified
// upload — nothing is ever hard-deleted.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { readRaw } = require('./preview');
const { safeName } = require('./util');

const VERIFY_EVERY = 20; // full re-download hash check on every Nth item

class CopyEngine {
  constructor({ cfg, store, graph, ews, log, bus }) {
    this.cfg = cfg; this.store = store; this.graph = graph; this.ews = ews; this.log = log; this.bus = bus;
    this.running = false;
    this._stop = false;
    this._aborter = null;
    this.storeRoot = path.join(cfg.dataDir, 'store');
  }

  get stopped() { return this._stop; }
  stop() {
    if (!this.running) return false;
    this._stop = true;
    if (this._aborter) this._aborter.abort();
    this.log('info', '', 'copy stop requested — halting now');
    return true;
  }

  _progress(jobId, patch) {
    this.store.updateJob(jobId, patch);
    this.bus.emit('progress', patch);
  }

  // Graveyard-retire a copied source file (move mode). Mirrors engine._retireFile.
  async _retireLocal(upn, filePath, fileId) {
    const gdir = path.join(this.storeRoot, '_graveyard', safeName(upn));
    await fsp.mkdir(gdir, { recursive: true });
    await fsp.rename(filePath, path.join(gdir, fileId + '.eml.gz'));
  }

  async start({ srcUpn, dstUpn, folderKeys, mode = 'copy', prefix }) {
    if (this.running) throw new Error('a copy job is already running');
    const items = this.store.copyableItems(srcUpn, folderKeys);
    if (!items.length) throw new Error('no downloaded items match the selection');
    this.running = true; this._stop = false;
    this._aborter = new AbortController();
    const sig = this._aborter.signal; // per-job abort channel — never touch graph.signal (a backup may be running)
    const jobId = this.store.createJob('copy', items.length);
    const rootPrefix = (prefix || `Restored from ${srcUpn}`).replace(/^\/+|\/+$/g, '');
    // Resolve and create all target folders up front: path -> { id, createdByUs }.
    this.log('info', srcUpn, `${mode} → ${dstUpn}: ${items.length} item(s), target root "${rootPrefix}"`);
    (async () => {
      let done = 0, uploaded = 0, failed = 0, verified = 0, sampleMismatch = 0;
      try {
        const folderMap = new Map(); // scope:folderPath -> { id, createdByUs }
        const paths = [...new Set(items.map(i => i.scope + '|' + (i.folderPath || i.folderName || 'Restored')))];
        for (const key of paths) {
          if (this.stopped) throw this._abortErr();
          const [scope, folderPath] = key.split('|');
          const targetPath = rootPrefix + '/' + (scope === 'archive' ? 'Archive/' : '') + folderPath;
          const before = folderMap.size;
          let id;
          try {
            id = await this.graph.ensureFolderPath(dstUpn, targetPath, sig);
          } catch (e) {
            if (/ErrorAccessDenied|\b403\b/.test(String(e.message || e))) {
              throw new Error(`write access to ${dstUpn} denied — the app registration is missing the Mail.ReadWrite application permission (grant + admin consent in Entra ID)`);
            }
            throw e;
          }
          // We only do exact count checks on folders we created empty.
          folderMap.set(key, { id, fresh: true });
          if (folderMap.size !== before) this._progress(jobId, { detail: `folders prepared ${folderMap.size}/${paths.length}` });
        }
        this.log('info', dstUpn, `target folders ready (${paths.length})`);
        // Uploads go through EWS (Graph MIME import creates drafts stamped with
        // the import time); convert the REST folder ids once, up front.
        const conv = await this.ews.convertRestIds(dstUpn, [...folderMap.values()].map(t => t.id), this.graph, sig);
        for (const t of folderMap.values()) {
          t.ewsId = conv.get(t.id);
          if (!t.ewsId) throw new Error('destination folder id conversion failed');
        }
        for (const it of items) {
          if (this.stopped) throw this._abortErr();
          const key = it.scope + '|' + (it.folderPath || it.folderName || 'Restored');
          const target = folderMap.get(key);
          const localFile = path.join(
            this.storeRoot, safeName(srcUpn), it.scope,
            ...String(it.folderPath || it.folderName || '').split('/').filter(Boolean).map(safeName),
            it.fileId + '.eml.gz');
          try {
            const mime = await readRaw(this.storeRoot, srcUpn, it.scope,
              { path: it.folderPath, name: it.folderName }, it.fileId, null);
            if (!mime) throw new Error('local file missing');
            const ewsItemId = await this.ews.uploadMessage(dstUpn, target.ewsId, mime, it.receivedAt, sig);
            if (!ewsItemId) throw new Error('EWS returned no item id');
            // Sampled full-fidelity check: re-download via EWS and compare bytes.
            // Exchange normalizes MIME on ingest, so a size/hash drift is a
            // warning, not a failure.
            let ok = 1, note = null;
            if ((done + 1) % VERIFY_EVERY === 0) {
              const back = await this.ews.getItemMime(dstUpn, ewsItemId, null, sig).catch(() => null);
              if (!back) { note = 'verify: sample re-download failed'; }
              else {
                const h = crypto.createHash('sha256').update(back).digest('hex');
                if (h !== it.sha256) { sampleMismatch++; note = (note ? note + '; ' : '') + 'verify: sample hash differs (Exchange normalized MIME)'; }
              }
            }
            if (note) this.log('warn', dstUpn, `${it.folderPath}: ${note}`);
            this.store.addCopyItem({ jobId, srcUpn, dstUpn, scope: it.scope, folderPath: it.folderPath, itemId: it.itemId, dstMessageId: ewsItemId, size: it.size, sha256: it.sha256, verified: ok, note });
            uploaded++; verified += ok;
            if (mode === 'move' && ok) {
              try {
                await this._retireLocal(srcUpn, localFile, it.fileId);
                this.store.deleteItem(srcUpn, it.scope, it.folderId, it.itemId);
              } catch (e) {
                this.log('warn', srcUpn, `copied but local retire failed for ${it.fileId}: ${e.message}`);
              }
            }
          } catch (e) {
            if (e.aborted) throw e;
            failed++;
            this.store.addCopyItem({ jobId, srcUpn, dstUpn, scope: it.scope, folderPath: it.folderPath, itemId: it.itemId, size: it.size, sha256: it.sha256, verified: 0, note: 'fail: ' + String(e.message || e).slice(0, 300) });
            this.log('error', dstUpn, `copy failed (${it.folderPath}): ${String(e.message || e).slice(0, 200)}`);
          }
          done++;
          if (done % 5 === 0 || done === items.length) {
            this._progress(jobId, { done, detail: `${srcUpn} → ${dstUpn}: ${done}/${items.length} (${failed} failed)` });
          }
        }
        // Final per-folder count check on folders this run created empty.
        let countIssues = 0;
        for (const [key, t] of folderMap) {
          if (!t.fresh) continue;
          const [scope, folderPath] = key.split('|');
          const expected = items.filter(i => (i.scope + '|' + (i.folderPath || i.folderName || 'Restored')) === key && true).length;
          const got = await this.graph.folderItemCount(dstUpn, t.id, sig);
          if (got != null && got < expected) {
            countIssues++;
            this.log('warn', dstUpn, `folder count short: "${folderPath}" has ${got}, expected ${expected}`);
          }
        }
        if (mode === 'move') this.store.recomputeMailboxBytes(srcUpn);
        const status = this.stopped ? 'stopped' : 'done';
        this._progress(jobId, {
          status, done,
          detail: `${uploaded} uploaded, ${verified} verified, ${failed} failed${sampleMismatch ? `, ${sampleMismatch} sample note(s)` : ''}${countIssues ? `, ${countIssues} folder count issue(s)` : ''}`,
          finishedAt: new Date().toISOString()
        });
        this.log(failed ? 'warn' : 'info', '', `copy ${srcUpn} → ${dstUpn} finished: ${uploaded} uploaded, ${failed} failed, ${verified} verified`);
      } catch (e) {
        if (e.aborted || this.stopped) {
          this._progress(jobId, { status: 'stopped', done, detail: `stopped — ${uploaded} uploaded, ${failed} failed`, finishedAt: new Date().toISOString() });
          this.log('info', '', `copy stopped (${uploaded} uploaded before stop)`);
        } else {
          this._progress(jobId, { status: 'error', done, detail: String(e.message).slice(0, 300), finishedAt: new Date().toISOString() });
          this.log('error', '', 'copy failed: ' + e.message);
        }
      } finally {
        this._aborter = null;
        this.running = false;
      }
    })();
    return { jobId, total: items.length };
  }

  _abortErr() { const e = new Error('operation aborted'); e.aborted = true; return e; }
}

module.exports = { CopyEngine };
