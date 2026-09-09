/* ============================================================
   persistence.js — indexDB-backed storage + localStorage.

   WHY TWO STORES (and why IndexedDB is primary)
   ---------------------------------------------
   localStorage is synchronous (blocks the main thread), capped at
   ~5 MB, and only stores strings. For small settings it's ideal:
   the whole read costs microseconds.

   IndexedDB is asynchronous and capacity-based (typically hundreds
   of MB), which is what we want for DOCUMENT CONTENT, per-document
   state and version snapshots — writes are fire-and-forget so they
   never jank typing.

   Engineering rule we follow:
   - Settings/preferences (theme, lang, font, AI provider config,
     editor options): localStorage. Tiny, synchronous, always
     available immediately at boot.
   - Documents (content + cursor + scroll + undo-ish flags) and
     version history: IndexedDB. Larger, async, debounced writes.
   - Session state (open tab order, active doc, AI panel state):
     IndexedDB record with a localStorage mirror for a fast boot
     hint.

   DATA SAFETY
   -----------
   autosave(): debounced (app layer), plus immediate flush on
   visibilitychange / pagehide / beforeunload. If a write fails with
   QuotaExceededError we surface a warning toast and prune oldest
   version snapshots before giving up.

   NOTE: this module exposes primitives; documents.js/app.js decide
   WHEN to persist and WHAT a document record looks like.
   ============================================================ */

const DB_NAME = 'te-editor';
const DB_VERSION = 1;
const LS_PREFIX = 'te.';

export class Storage {
  constructor() {
    this._db = null;
    this._ready = null;
    this.available = false;        // set true once IndexedDB opens
    this._sw = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
    this.listener = null;      // set by app to update the save indicator
    this.quotaExceeded = false;
  }

  /* ---------------- LocalStorage helpers ---------------- */

  lsGet(key, def = null) {
    try {
      const v = localStorage.getItem(LS_PREFIX + key);
      return v === null ? def : JSON.parse(v);
    } catch { return def; }
  }

  lsSet(key, val) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(val)); }
    catch (e) {
      if (e && e.name === 'QuotaExceededError') this._onQuota();
    }
  }

  lsDel(key) { try { localStorage.removeItem(LS_PREFIX + key); } catch {} }

  /* ---------------- IndexedDB ---------------- */

  open() {
    if (this._ready) return this._ready;
    if (!('indexedDB' in window)) {
      this._ready = Promise.reject(new Error('IndexedDB not available'));
      return this._ready;
    }
    // If IndexedDB never fires (some headless/private contexts), don't
    // hang the whole editor forever — fail fast into memory mode.
    const timeout = new Promise((_, reject) => setTimeout(() => {
      if (!this.available) reject(new Error('IndexedDB open timed out'));
    }, 2500));
    let resolve_, reject_;
    this._ready = new Promise((resolve, reject) => { resolve_ = resolve; reject_ = reject; });
    const openReq = indexedDB.open(DB_NAME, DB_VERSION);
    openReq.onupgradeneeded = (e) => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains('docs')) {
        db.createObjectStore('docs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('versions')) {
        const vs = db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true });
        vs.createIndex('docId', 'docId', { unique: false });
        vs.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains('session')) {
        db.createObjectStore('session', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('recents')) {
        db.createObjectStore('recents', { keyPath: 'id' });
      }
    };
    openReq.onsuccess = () => {
      this._db = openReq.result;
      this._db.onerror = () => {};
      this.available = true;
      resolve_(this._db);
    };
    openReq.onerror = () => reject_(openReq.error);
    openReq.onblocked = () => reject_(new Error('IndexedDB blocked'));
    this._ready = Promise.race([this._ready, timeout]);
    return this._ready;
  }

  async _tx(name, mode, fn) {
    if (!this.available) throw new Error('storage unavailable');
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const store = tx.objectStore(name);
      const out = fn(store);
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /* ---------------- Document records ---------------- */

  async saveDoc(rec) {
    try {
      const out = await this._tx('docs', 'readwrite', (s) => s.put(rec));
      if (this.listener) this.listener('saved');
      return out;
    } catch (e) {
      if (this._isQuota(e)) {
        this._onQuota();
        await this._pruneOldVersions(rec.id, 10);
        throw e;
      }
      throw e;
    }
  }

  async loadAllDocs() {
    if (!this.available) return [];
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction('docs', 'readonly');
        const req = tx.objectStore('docs').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch { return []; }
  }

  async deleteDoc(id) {
    await this._tx('docs', 'readwrite', (s) => s.delete(id));
    await this._tx('versions', 'readwrite', (s) => {
      const idx = s.index('docId');
      const req = idx.getAllKeys(IDBKeyRange.only(id));
      req.onsuccess = () => req.result.forEach(k => s.delete(k));
    });
  }

  /* ---------------- Settings (indexedDB copy) ---------------- */

  async saveI(key, val) {
    await this._tx('settings', 'readwrite', (s) => s.put({ key, val }));
  }
  async getI(key) {
    const out = await this._tx('settings', 'readonly', (s) => s.get(key));
    return out ? out.val : undefined;
  }

  /* ---------------- Session ---------------- */

  async saveSession(sess) {
    await this._tx('session', 'readwrite', (s) => s.put({ id: 'main', ...sess, ts: Date.now() }));
    // mirror a tiny part in localStorage for instant boot decisions
    this.lsSet('sessionHint', { activeDocId: sess.activeDocId, tabs: sess.tabs, hasSession: true });
  }

  async loadSession() {
    if (!this.available) return null;
    try {
      const out = await this._tx('session', 'readonly', (s) => s.get('main'));
      return out || null;
    } catch { return null; }
  }

  /* ---------------- Version snapshots ---------------- */

  async saveVersion(docId, text, meta = {}) {
    try {
      await this._tx('versions', 'readwrite', (s) => s.put({
        docId, ts: Date.now(), text, title: meta.title, excerpt: meta.excerpt || text.slice(0, 120),
      }));
      return true;
    } catch (e) {
      if (this._isQuota(e)) {
        await this._pruneOldVersions(docId, 20);
        try { await this._tx('versions', 'readwrite', (s) => s.put({ docId, ts: Date.now(), text })); } catch {}
      }
      return false;
    }
  }

  async loadVersions(docId) {
    if (!this.available) return [];
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction('versions', 'readonly');
        const idx = tx.objectStore('versions').index('docId');
        const req = idx.getAll(IDBKeyRange.only(docId));
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.ts - a.ts));
        req.onerror = () => resolve([]);
      });
    } catch { return []; }
  }

  async _pruneOldVersions(docId, keep) {
    const rows = await this.loadVersions(docId);
    for (let i = keep; i < rows.length; i++) {
      await this._tx('versions', 'readwrite', (s) => s.delete(rows[i].id));
    }
  }

  /* ---------------- Recents ---------------- */

  async saveRecent(rec) {
    await this._tx('recents', 'readwrite', (s) => s.put({ id: rec.id, name: rec.name, ts: rec.ts }));
  }
  async loadRecents() {
    if (!this.available) return [];
    try {
      const out = await this._tx('recents', 'readonly', (s) => s.getAll());
      return (out || []).sort((a, b) => b.ts - a.ts);
    } catch { return []; }
  }
  async clearRecents() {
    await this._tx('recents', 'readwrite', (s) => s.clear());
  }

  /* ---------------- Error handling ---------------- */

  _isQuota(e) {
    return e && (e.name === 'QuotaExceededError' || e.code === 22 || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
  }

  _onQuota() {
    this.quotaExceeded = true;
    if (this.listener) this.listener('error');
  }

  /** Estimate total storage used (best-effort, async). */
  async estimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        return await navigator.storage.estimate();
      }
    } catch {}
    return null;
  }
}

export const storage = new Storage();
export default storage;