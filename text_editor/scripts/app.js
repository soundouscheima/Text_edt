/* ============================================================
   app.js — boot sequence + wiring. Everything hangs off this.

   Roles:
   - Boot: read settings (localStorage) → open IndexedDB → restore
     session (tabs, active doc, cursors, scroll) → create Document
     objects → build tab bar → start rendering.
   - Coordinator: exposes getActiveDoc() / afterEdit() / afterMove()
     / toast() / saveNow() … that the other modules call.
   - Owns: settings, the Markdown preview + outline readers, Find &
     Replace, statistics, versions, recents, focus mode, tour, and
     the glue between renderer ↔ documents ↔ input ↔ AI.
   ============================================================ */

import { PieceTableBuffer } from './buffer.js';
import { Renderer } from './renderer.js';
import { InputController } from './input.js';
import { AiAssistant } from './ai.js';
import { storage } from './persistence.js';
import { i18n } from './i18n.js';
import { Document, findInDoc } from './documents.js';
import { InsertTextCommand, ReplaceSelectionCommand } from './commands.js';
import { icons } from './icons.js';
import { debounce, downloadBlob, escapeHtml, formatNumber, readingTime, uid } from './util.js';

const LS = (k, def) => {
  try { const v = localStorage.getItem('te.' + k); return v == null ? def : JSON.parse(v); } catch { return def; }
};
const LSS = (k, v) => { try { localStorage.setItem('te.' + k, JSON.stringify(v)); } catch {} };

class App {
  constructor() {
    this.docs = new Map();          // id → Document
    this.order = [];               // tab order
    this.activeId = null;
    this.online = navigator.onLine;
    this.focusMode = false;
    this.saveState = 'saved';
    this.versionTimer = null;
    this.lastSnapshotText = null;
    this.lastSnapshotAt = 0;
    this.dragOverlayEl = null;
    this._statusTimer = null;
    this._aiPanelWasOpen = false;
    this._settingsModal = null;
    this._helpModal = null;

    // Modules (construction order matters).
    this.renderer = null;
    this.input = null;
    this.ai = null;
    this.find = null;
    this.cmds = { InsertTextCommand, ReplaceSelectionCommand };
  }

  /* ============================================================
     BOOT
     ============================================================ */

  async boot() {
    // 1) settings from localStorage — synchronous, instant UI.
    this.settings = {
      theme: LS('theme', 'dark'),
      lang: LS('lang', 'en'),
      fontSize: LS('fontSize', 16),
      fontFamily: LS('fontFamily', "Consolas, 'Courier New', monospace"),
      wrap: LS('wrap', true),
      lineNumbers: LS('lineNumbers', true),
      lineHeight: LS('lineHeight', 1.5),
      docDir: LS('docDir', 'auto'),
      tourSeen: LS('tourSeen', false),
    };

    document.documentElement.dataset.theme = this.settings.theme;
    i18n.setLocale(this.settings.lang);

    // 2) build the chrome DOM (settings button, find bar, overlays)
    this._buildChrome();

    // 3) renderer + input + AI
    this.renderer = new Renderer({
      viewport: document.getElementById('viewport'),
      lines: document.getElementById('lines'),
      gutter: document.getElementById('gutter'),
      selectionLayer: document.getElementById('selection-layer'),
      caretEl: document.getElementById('caret'),
    });
    this.input = new InputController(this);
    this.ai = new AiAssistant(this);
    this.find = this._makeFind();
    this.input.attach();

    // 4) restore documents from IndexedDB
    try { await storage.open(); } catch (e) { console.warn('storage unavailable — running in memory mode', e); }
    storage.listener = (state) => {
      if (state === 'error') {
        this.saveState = 'error';
        this._setSaveStatus('error');
        this.toast('toastQuota', { type: 'error' });
      }
    };
    let fetchedDocs = [];
    let session = null;
    if (storage.available) {
      fetchedDocs = await storage.loadAllDocs();
      session = await storage.loadSession();
    }

    const tabOrder = (session && session.tabs) || fetchedDocs.map(d => d.id);
    const seen = new Set();
    for (const id of tabOrder) {
      const rec = fetchedDocs.find(r => r.id === id);
      if (rec && !seen.has(id)) { this._hydrateDoc(rec); seen.add(id); }
    }
    for (const rec of fetchedDocs) {
      if (!seen.has(rec.id)) this._hydrateDoc(rec);
    }
    if (this.order.length === 0) this.newDocument(true);

    const activeId = (session && session.activeDocId && this.docs.has(session.activeDocId))
      ? session.activeDocId : this.order[0];
    this._activate(activeId, { restoreScroll: true });

    // 5) online/offline + lifecycle hooks
    window.addEventListener('online', () => { this.online = true; this.ai.setOnline(true); });
    window.addEventListener('offline', () => { this.online = false; this.ai.setOnline(false); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.saveNow(true); });
    window.addEventListener('pagehide', () => this.saveNow(true));
    window.addEventListener('beforeunload', () => this.saveNow(true));

    // 6) input + UI wiring
    this._wireUI();

    // 7) AI panel persisted state
    const aiState = LS('aiPanelOpen', false);
    if (aiState) this.ai.openPanel();
    if (session && session.aiOpen) this.ai.openPanel();

    // 8) optional first-run tour
    if (!this.settings.tourSeen && this.order.length <= 1) {
      setTimeout(() => this._startTour(), 600);
    }

    // 9) periodic version snapshots
    this.versionTimer = setInterval(() => this._maybeSnapshot(), 2 * 60 * 1000);

    this.toast('restoreSession', { type: 'success' });
  }

  _hydrateDoc(rec) {
    const doc = new Document({
      id: rec.id,
      title: rec.title || 'Untitled',
      text: rec.text || '',
      cursor: rec.cursor,
      selection: rec.selection,
      dir: rec.dir || 'auto',
      isMarkdown: rec.isMarkdown,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      chat: rec.chat || [],
      scrollTop: rec.scrollTop,
      scrollLeft: rec.scrollLeft,
    });
    this._wireDoc(doc);
    this.docs.set(doc.id, doc);
    this.order.push(doc.id);
  }

  _wireDoc(doc) {
    doc.onVersionBump = (d) => {
      const { line } = d.buffer.offsetToLineColumn(Math.min(d._lastEditOffset ?? 0, d.buffer.getTotalLength()));
      this.renderer.invalidateFromLine(line);
      this.renderer.render();
      this._queueStatus();
      this.scheduleSave(500);
    };
    doc.onDirtyChange = (d) => this._paintTabDirty(d);
    doc.history.onChange = () => this.historyChanged();
    doc._onHistoryChange = () => this.historyChanged();
  }

  /* Objects the input controller lives with */
  getActiveDoc() {
    return this.activeId ? this.docs.get(this.activeId) : null;
  }

  /* ============================================================
     UI chrome (built programmatically to keep HTML lean)
     ============================================================ */

  _buildChrome() {
    // Settings button
    const group = document.createElement('div');
    group.className = 'toolbar-group';
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.id = 'btn-settings';
    btn.innerHTML = icons.settings;
    btn.setAttribute('data-tip', 'settings');
    btn.setAttribute('aria-label', 'settings');
    group.appendChild(btn);
    document.querySelector('.toolbar-group.toolbar-group-attach').after(group);

    // Find bar content
    const fb = document.getElementById('findbar');
    fb.innerHTML = `
      <div class="fb-row">
        <input type="text" id="fb-find" data-i18n-placeholder="findPlaceholder">
        <span class="fb-count" id="fb-count"></span>
        <div class="fb-buttons">
          <button class="icon-btn" id="fb-prev" data-tip="prevMatch" data-i18n-title="prevMatch">${icons.chevronUp}</button>
          <button class="icon-btn" id="fb-next" data-tip="nextMatch" data-i18n-title="nextMatch">${icons.chevronDown}</button>
          <button class="icon-btn" id="fb-close" data-tip="close" data-i18n-title="close">${icons.close}</button>
        </div>
      </div>
      <div class="fb-row">
        <input type="text" id="fb-replace" data-i18n-placeholder="replacePlaceholder">
        <div class="fb-buttons">
          <button class="text-btn" id="fb-replace1" data-i18n-title="replace">${i18n.t('replace')}</button>
          <button class="text-btn primary" id="fb-replaceall" data-i18n-title="replaceAll">${i18n.t('replaceAll')}</button>
        </div>
      </div>
      <div class="fb-opts">
        <label><input type="checkbox" id="fb-case" >${i18n.t('matchCase')}</label>
        <label><input type="checkbox" id="fb-word" >${i18n.t('wholeWord')}</label>
        <label><input type="checkbox" id="fb-regex" >${i18n.t('regex')}</label>
      </div>`;
    fb.addEventListener('click', (e) => e.stopPropagation());

    // Drag overlay
    this.dragOverlayEl = document.createElement('div');
    this.dragOverlayEl.className = 'drag-overlay hidden';
    this.dragOverlayEl.textContent = i18n.t('dragTitle');
    document.body.appendChild(this.dragOverlayEl);

    // keyboard nav indicator (pulse class)
    document.addEventListener('keydown', () => document.body.classList.add('using-keyboard'));
    document.addEventListener('mousedown', () => document.body.classList.remove('using-keyboard'));
  }

  _wireUI() {
    const $ = (id) => document.getElementById(id);

    $('btn-new').addEventListener('click', () => this.newDocument());
    $('btn-open').addEventListener('click', () => this.openFile());
    $('btn-export').addEventListener('click', () => this.exportCurrent());
    $('btn-undo').addEventListener('click', () => { this.getActiveDoc()?.undo(); this._queueStatus(); });
    $('btn-redo').addEventListener('click', () => { this.getActiveDoc()?.redo(); this._queueStatus(); });
    $('btn-fontup').addEventListener('click', () => this.zoomIn());
    $('btn-fontdown').addEventListener('click', () => this.zoomOut());
    $('btn-wrap').addEventListener('click', () => this.toggleWrap());
    $('btn-find').addEventListener('click', () => this.find.open());
    $('btn-outline').addEventListener('click', () => this.toggleOutline());
    $('btn-preview').addEventListener('click', () => this.togglePreview());
    $('btn-focus').addEventListener('click', () => this.toggleFocusMode());
    $('btn-help').addEventListener('click', () => this.help.show());
    $('btn-ai-toggle').addEventListener('click', () => this.ai.togglePanel());
    $('btn-ai-close').addEventListener('click', () => this.ai.closePanel());
    $('btn-ai-settings').addEventListener('click', () => this.ai.toggleSettings());
    $('btn-ai-send').addEventListener('click', () => this.ai.send(this.ai.inputEl.value));
    $('btn-lang-en').addEventListener('click', () => this.setUILanguage('en'));
    $('btn-lang-ar').addEventListener('click', () => this.setUILanguage('ar'));
    $('file-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) { this.toast('toastNoFile', { type: 'warning' }); return; }
      const reader = new FileReader();
      reader.onload = () => this.importDocument(f.name, String(reader.result || ''));
      reader.readAsText(f);
    });

    // AI input: enter to send, shift+enter newline, auto-grow
    const aiIn = $('ai-input');
    aiIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.ai.send(aiIn.value);
      }
    });

    const btnSettings = $('btn-settings');
    btnSettings.addEventListener('click', () => this.openSettings());

    // Centralized shortcut help wiring is in InputController; here we
    // only start the tooltip + aria-label translation pass.
    i18n.applyDom(document.body);
    i18n.onChanged(() => { i18n.applyDom(document.body); this._updateChromeText(); });

    // Escape closes panels/modals.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.focusMode) { this.toggleFocusMode(); return; }
      if (this.find.isOpen()) { this.find.close(); return; }
      if (this.ai.panelOpen && !this.ai._inSettings) { this.ai.closePanel(); return; }
      this.closeModals();
    });

    this._historyChangedRef = () => this.historyChanged();
  }

  _updateChromeText() {
    this.find._renderStatic();
    document.getElementById('fb-replace1').textContent = i18n.t('replace');
    document.getElementById('fb-replaceall').textContent = i18n.t('replaceAll');
    this.dragOverlayEl.textContent = i18n.t('dragTitle');
  }

  /* ============================================================
     Document management
     ============================================================ */

  newDocument(isFirst = false) {
    const doc = new Document({ title: i18n.t('untitled') + (isFirst ? '' : ' ' + (this.order.length + 1)) });
    this._wireDoc(doc);
    this.docs.set(doc.id, doc);
    this.order.push(doc.id);
    this.renderTabs();
    this._activate(doc.id);
    this.saveNow();
    this.input.focusEditor();
  }

  closeDocument(id) {
    if (this.order.length <= 1) return;
    const idx = this.order.indexOf(id);
    if (idx === -1) return;
    this.order.splice(idx, 1);
    this.docs.delete(id);
    if (this.activeId === id) {
      this.activeId = this.order[Math.min(idx, this.order.length - 1)];
      this._activate(this.activeId, { full: true });
    }
    this.renderTabs();
    storage.deleteDoc(id).catch(() => {});
    this.saveNow();
  }

  _activate(id, opts = {}) {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.activeId = id;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));

    this.renderer.setBuffer(doc.buffer);
    this.renderer.setOptions({
      wrap: this.settings.wrap,
      showLineNumbers: this.settings.lineNumbers,
      fontSize: this.settings.fontSize,
      fontFamily: this.settings.fontFamily,
      docDir: this._docDir(doc),
    });
    this.renderer.setSelection(doc.selection);
    this.renderer.scrollTop = doc.scrollTop;
    this.renderer.scrollLeft = doc.scrollLeft;
    this.renderer.viewport.scrollTop = doc.scrollTop;
    this.renderer.viewport.scrollLeft = doc.scrollLeft;
    this.renderer.moveCursorTo(doc.cursor);

    if (this.find.isOpen()) this.find.update();
    this._refreshSidePane();
    this.updateStatus(true);
    this.historyChanged();
    this._paintTabDirty(doc);

    if (this.ai.panelOpen) this.ai._render();

    // Reposition the input proxy over the caret.
    this._placeProxy();
  }

  _docDir(doc) {
    if (doc.dir !== 'auto') return doc.dir;
    const text = doc.buffer.getText();
    let rtl = 0, ltr = 0;
    for (let i = 0; i < Math.min(text.length, 40000); i++) {
      const cp = text.charCodeAt(i);
      if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) || (cp >= 0x08A0 && cp <= 0x08FF)) rtl++;
      else if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || (cp >= 0xC0 && cp <= 0x2AF)) ltr++;
    }
    return rtl > ltr ? 'rtl' : 'ltr';
  }

  renderTabs() {
    const bar = document.getElementById('tabbar');
    bar.textContent = '';
    for (const id of this.order) {
      const doc = this.docs.get(id);
      const tab = document.createElement('div');
      tab.className = 'tab' + (id === this.activeId ? ' active' : '') + (doc.dirty ? ' dirty' : '');
      tab.dataset.id = id;
      tab.setAttribute('role', 'tab');
      tab.title = doc.title;
      const span = document.createElement('span');
      span.className = 'tab-title';
      span.textContent = doc.title;
      const dot = document.createElement('span');
      dot.className = 'tab-dirty';
      const btn = document.createElement('button');
      btn.className = 'tab-close';
      btn.innerHTML = icons.close;
      btn.setAttribute('aria-label', i18n.t('closeTab'));
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.closeDocument(id); });
      tab.appendChild(span);
      tab.appendChild(dot);
      tab.appendChild(btn);
      tab.addEventListener('click', () => {
        if (this.activeId !== id) this._activate(id, { full: true });
        this.input.focusEditor();
      });
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) this.closeDocument(id); });
      bar.appendChild(tab);
    }
  }

  _paintTabDirty(doc) {
    const tab = document.querySelector(`.tab[data-id="${doc.id}"]`);
    if (!tab) return;
    tab.classList.toggle('dirty', doc.dirty);
  }

  /* ============================================================
     Editing callbacks from InputController
     ============================================================ */

  afterEdit(selStart, len) {
    const doc = this.getActiveDoc();
    if (!doc) return;
    if (selStart != null) {
      const { line } = doc.buffer.offsetToLineColumn(selStart);
      doc._lastEditOffset = selStart;
      this.renderer.invalidateFromLine(line);
    } else {
      this.renderer.invalidateFromLine(doc.cursor.line);
    }
    this.renderer.render();
    this.renderer.setSelection(doc.selection);
    this.renderer.moveCursorTo(doc.cursor);
    this._placeProxy();
    this.renderTabs();
    if (this.find.isOpen()) this.find.update();
    this._queueStatus();
    this.scheduleSave(500);
    void len;
  }

  afterMove() {
    const doc = this.getActiveDoc();
    if (!doc) return;
    this.renderer.setSelection(doc.selection);
    this.renderer.moveCursorTo(doc.cursor);
    this._placeProxy();
    this.updateStatus(true);
    this.scheduleSave(350);
  }

  _placeProxy() {
    const doc = this.getActiveDoc();
    if (!doc) return;
    const off = doc.buffer.lineColumnToOffset(doc.cursor.line, doc.cursor.column);
    const p = this.renderer.offsetToPx(off);
    this.renderer.positionInputProxy(p.x, p.y);
  }

  paintCaret() {
    const doc = this.getActiveDoc();
    if (doc) this.renderer.moveCursorTo(doc.cursor);
  }

  historyChanged() {
    const doc = this.getActiveDoc();
    if (!doc) return;
    document.getElementById('btn-undo').disabled = !doc.history.canUndo();
    document.getElementById('btn-redo').disabled = !doc.history.canRedo();
  }

  /* ---------------- Status bar ---------------- */

  _queueStatus() { debounce(() => this.updateStatus(true), 60)(); }

  updateStatus(force) {
    const doc = this.getActiveDoc();
    if (!doc) return;
    const cursor = doc.cursor;
    const elLn = document.getElementById('status-lncol');
    elLn.textContent = i18n.t('lineCol', { l: formatNumber(cursor.line + 1), c: formatNumber(cursor.column + 1) });

    const text = doc.buffer.getText();
    const words = (text.trim().match(/\S+/g) || []).length;
    const chars = text.length;
    document.getElementById('status-words').textContent = `${formatNumber(words)} ${i18n.t('words')}`;
    document.getElementById('status-chars').textContent = `${formatNumber(chars)} ${i18n.t('chars')}`;
    const dl = this._docDir(doc);
    document.getElementById('status-dir').textContent = i18n.t(dl === 'rtl' ? 'rtl' : 'ltr');
    void force;
  }

  /* ---------------- Persistence (autosave) ---------------- */

  scheduleSave(delay = 500) {
    clearTimeout(this._saveTimer);
    this._setSaveStatus('saving');
    this._saveTimer = setTimeout(() => this.saveNow(), delay);
  }

  async saveNow(flush) {
    clearTimeout(this._saveTimer);
    const doc = this.getActiveDoc();
    if (!doc) return;
    if (!storage.available) {
      // IndexedDB unavailable/hung: keep editing; persistence is
      // best-effort. Mark clean so we don't spin on retries.
      doc.setDirty(false);
      this._paintTabDirty(doc);
      this._setSaveStatus('saved');
      return;
    }
    this._setSaveStatus('saving');
    try {
      // persist this doc + session + recents
      const rec = { ...doc.serialize(), scrollTop: this.renderer.scrollTop, scrollLeft: this.renderer.scrollLeft };
      await storage.saveDoc(rec);
      await storage.saveSession({
        activeDocId: this.activeId,
        tabs: this.order,
        aiOpen: this.ai.panelOpen,
      });
      await storage.saveRecent({ id: doc.id, name: doc.title, ts: Date.now() });
      if (this.ai.panelOpen) LSS('aiPanelOpen', true);
      else LSS('aiPanelOpen', false);
      doc.setDirty(false);
      this._paintTabDirty(doc);
      this._setSaveStatus(doc.title ? 'saved' : 'saved');
    } catch (e) {
      if (storage._isQuota(e)) { this._setSaveStatus('error'); this.toast('toastQuota', { type: 'error' }); return; }
      this._setSaveStatus('error');
    }
    void flush;
  }

  _setSaveStatus(s) {
    this.saveState = s;
    const el = document.getElementById('status-save');
    el.textContent = s === 'saved' ? i18n.t('saved') : s === 'saving' ? i18n.t('saving') : i18n.t('saveFailed');
    el.classList.toggle('saved', s === 'saved');
    el.classList.toggle('saving', s === 'saving');
    el.classList.toggle('error', s === 'error');
  }

  async _maybeSnapshot() {
    const doc = this.getActiveDoc();
    if (!doc) return;
    const text = doc.buffer.getText();
    const now = Date.now();
    if (text === this.lastSnapshotText) return;
    if (now - this.lastSnapshotAt < 2 * 60 * 1000 && this.lastSnapshotAt) return;
    this.lastSnapshotText = text;
    this.lastSnapshotAt = now;
    this.renderer._updateDocHeight();
    if (!storage.available) return;
    const est = await storage.estimate();
    if (est && est.usage / est.quota > 0.9) { this.toast('toastStorageLow', { type: 'warning' }); }
    await storage.saveVersion(doc.id, text, { title: doc.title });
  }

  /* ============================================================
     File I/O (client-side only)
     ============================================================ */

  importDocument(name, text) {
    const doc = new Document({ title: name || 'Untitled', text });
    this._wireDoc(doc);
    this.docs.set(doc.id, doc);
    this.order.push(doc.id);
    this.renderTabs();
    this._activate(doc.id);
    this.toast('toastImported', { vars: { name } });
    this.saveNow();
    this.input.focusEditor();
  }

  openFile() {
    document.getElementById('file-input').click();
  }

  exportCurrent() {
    const doc = this.getActiveDoc();
    if (!doc) return;
    const text = doc.buffer.getText();
    const ext = /\.md$/i.test(doc.title) ? 'md' : 'txt';
    const name = (doc.title || 'untitled').replace(/\.[^.]+$/, '') + '.' + ext;
    downloadBlob(name, new Blob([text], { type: 'text/plain;charset=utf-8' }));
    this.toast('toastExported', { vars: { name } });
  }

  /* ============================================================
     Fonts / theme / wrap / zoom
     ============================================================ */

  applyEditorPrefs() {
    this.renderer.setOptions({
      wrap: this.settings.wrap,
      showLineNumbers: this.settings.lineNumbers,
      fontSize: this.settings.fontSize,
      fontFamily: this.settings.fontFamily,
      lineHeight: this.settings.lineHeight,
    });
    this.renderer.refreshLayout();
    this.scheduleSave(300);
  }

  toggleWrap() {
    this.settings.wrap = !this.settings.wrap;
    LSS('wrap', this.settings.wrap);
    this.applyEditorPrefs();
    this._refIcon('btn-wrap', this.settings.wrap ? 'wrap' : 'wrap');
    this.updateTip('btn-wrap', this.settings.wrap ? 'wrapOn' : 'wrapOff');
  }

  zoomIn() { this.settings.fontSize = Math.min(48, this.settings.fontSize + 1); LSS('fontSize', this.settings.fontSize); this.applyEditorPrefs(); }
  zoomOut() { this.settings.fontSize = Math.max(8, this.settings.fontSize - 1); LSS('fontSize', this.settings.fontSize); this.applyEditorPrefs(); }
  resetZoom() { this.settings.fontSize = 16; LSS('fontSize', 16); this.applyEditorPrefs(); }

  setTheme(theme) {
    this.settings.theme = theme;
    LSS('theme', theme);
    document.documentElement.dataset.theme = theme;
  }

  setUILanguage(loc) {
    i18n.setLocale(loc);
    this.settings.lang = loc;
    LSS('lang', loc);
    document.getElementById('btn-lang-en').classList.toggle('active', loc === 'en');
    document.getElementById('btn-lang-ar').classList.toggle('active', loc === 'ar');
    this._updateChromeText();
    if (this.find.isOpen()) this.find._renderStatic();
    this.updateStatus(true);
    if (this.ai.panelOpen) this.ai._render();
  }

  updateTip(id, key) {
    const el = document.getElementById(id);
    if (el) el.setAttribute('data-tip', i18n.t(key));
  }
  _refIcon(id, icon) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = icons[icon] || el.innerHTML;
  }

  /* ============================================================
     Settings modal
     ============================================================ */

  openSettings() {
    const t = i18n;
    const modal = this._makeModal();
    modal.querySelector('.modal-title').textContent = t.t('settingsTitle');
    const body = modal.querySelector('.modal-body');

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:16px;max-width:520px';
    const field = (label, control) => {
      const f = document.createElement('div');
      f.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
      const l = document.createElement('label');
      l.style.cssText = 'font-weight:600';
      l.textContent = label;
      f.appendChild(l);
      f.appendChild(control);
      return f;
    };

    // UI language
    const langSel = document.createElement('select');
    langSel.innerHTML = `<option value="en">English</option><option value="ar">العربية</option>`;
    langSel.value = this.settings.lang;
    langSel.addEventListener('change', () => this.setUILanguage(langSel.value));
    wrap.appendChild(field(t.t('stUILanguage'), langSel));

    // Theme
    const themeSel = document.createElement('select');
    themeSel.innerHTML = `<option value="light">${t.t('stLight')}</option><option value="dark">${t.t('stDark')}</option>`;
    themeSel.value = this.settings.theme;
    themeSel.addEventListener('change', () => this.setTheme(themeSel.value));
    wrap.appendChild(field(t.t('stTheme'), themeSel));

    // Font size stepper
    const fs = document.createElement('div');
    fs.style.cssText = 'display:flex;align-items:center;gap:10px';
    const fsMinus = document.createElement('button'); fsMinus.className = 'text-btn'; fsMinus.textContent = '−';
    const fsVal = document.createElement('span'); fsVal.textContent = this.settings.fontSize + ' px'; fsVal.style.minWidth = '48px'; fsVal.style.textAlign = 'center';
    const fsPlus = document.createElement('button'); fsPlus.className = 'text-btn'; fsPlus.textContent = '+';
    fsMinus.addEventListener('click', () => { this.settings.fontSize = Math.max(8, this.settings.fontSize - 1); fsVal.textContent = this.settings.fontSize + ' px'; LSS('fontSize', this.settings.fontSize); this.applyEditorPrefs(); });
    fsPlus.addEventListener('click', () => { this.settings.fontSize = Math.min(48, this.settings.fontSize + 1); fsVal.textContent = this.settings.fontSize + ' px'; LSS('fontSize', this.settings.fontSize); this.applyEditorPrefs(); });
    fs.append(fsMinus, fsVal, fsPlus);
    wrap.appendChild(field(t.t('stFontSize'), fs));

    // Font family
    const ff = document.createElement('select');
    const fonts = [
      ["Consolas, 'Courier New', monospace", 'Consolas / Courier'],
      ["'JetBrains Mono', 'Noto Naskh Arabic', monospace", 'JetBrains Mono + Arabic'],
      ["monospace", 'Monospace'],
      ["'Segoe UI', Tahoma, sans-serif", 'Segoe UI'],
      ["Georgia, 'Times New Roman', serif", 'Georgia'],
      ["'Comic Sans MS', sans-serif", 'Comic Sans'],
      ["'Cairo', 'Segoe UI', sans-serif", 'Cairo'],
    ];
    ff.innerHTML = fonts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    ff.value = this.settings.fontFamily;
    ff.addEventListener('change', () => { this.settings.fontFamily = ff.value; LSS('fontFamily', this.settings.fontFamily); this.applyEditorPrefs(); });
    wrap.appendChild(field(t.t('stFontFamily'), ff));

    // line height
    const lhSel = document.createElement('select');
    [['1.2', '1.2'], ['1.4', '1.4'], ['1.5', '1.5'], ['1.8', '1.8'], ['2', '2']].forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; lhSel.appendChild(o);
    });
    lhSel.value = String(this.settings.lineHeight);
    lhSel.addEventListener('change', () => { this.settings.lineHeight = parseFloat(lhSel.value); LSS('lineHeight', this.settings.lineHeight); this.applyEditorPrefs(); });
    wrap.appendChild(field(t.t('stLineHeight'), lhSel));

    // wrap toggle
    const w = document.createElement('input'); w.type = 'checkbox'; w.checked = this.settings.wrap;
    w.addEventListener('change', () => this.toggleWrap());
    wrap.appendChild(field(t.t('stWrap'), w));

    // line numbers
    const ln = document.createElement('input'); ln.type = 'checkbox'; ln.checked = this.settings.lineNumbers;
    ln.addEventListener('change', () => { this.settings.lineNumbers = ln.checked; LSS('lineNumbers', ln.checked); this.renderer.setOptions({ showLineNumbers: ln.checked }); });
    wrap.appendChild(field(t.t('stLineNumbers'), ln));

    // default text direction
    const dirSel = document.createElement('select');
    dirSel.innerHTML = `<option value="auto">${t.t('stDirAuto')}</option><option value="ltr">${t.t('stDirLtr')}</option><option value="rtl">${t.t('stDirRtl')}</option>`;
    dirSel.value = this.settings.docDir;
    dirSel.addEventListener('change', () => { this.settings.docDir = dirSel.value; LSS('docDir', dirSel.value); this._activate(this.activeId); });
    wrap.appendChild(field(t.t('stTextDirection'), dirSel));

    body.appendChild(wrap);
  }

  _makeModal() {
    this.closeModals();
    const t = i18n;
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.id = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="modal-header">
        <span class="modal-title"></span>
        <button class="icon-btn modal-close" data-tip="close" aria-label="close">${icons.close}</button>
      </div>
      <div class="modal-body"></div>`;
    modal.querySelector('.modal-close').addEventListener('click', () => ov.remove());
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
    ov.appendChild(modal);
    document.body.appendChild(ov);
    this._activeModal = ov;
    return modal;
  }

  closeModals() {
    if (this._activeModal) { this._activeModal.remove(); this._activeModal = null; }
  }

  /* ============================================================
     Help modal (shortcut cheat-sheet)
     ============================================================ */

  help = {
    show: () => {
      const t = i18n;
      const modal = this._makeModal();
      modal.querySelector('.modal-title').textContent = t.t('shortcutsTitle');
      const body = modal.querySelector('.modal-body');
      const rows = [
        ['arrows', 'Key: move caret'], ['shiftArrows', 'Shift+Arrows: extend selection'],
        ['ctrlArrows', 'Ctrl+Arrows: jump word'], ['homeEnd', 'Home/End: start or end of line'],
        ['ctrlHomeEnd', 'Ctrl+Home/End: document start/end'], ['page', 'Page Up/Down: page'],
        ['ctrlZ', 'Ctrl+Z: undo'], ['ctrlY', 'Ctrl+Y / Ctrl+Shift+Z: redo'],
        ['ctrlFind', 'Ctrl+F: find & replace'], ['ctrlS', 'Ctrl+S: export'],
        ['ctrlN', 'Ctrl+N: new document'], ['ctrlO', 'Ctrl+O: open file'],
        ['ctrlA', 'Ctrl+A: select all'], ['ctrlK', 'Ctrl+K: AI assistant'],
        ['ctrlIp', 'Ctrl+Plus/Minus: zoom'], ['f11', 'F11: focus mode'],
        ['ctrlSlash', 'Ctrl+Slash: this screen'], ['ctrlShiftM', 'Ctrl+Shift+M: markdown preview'],
        ['ctrlG', 'Ctrl+G: outline'],
      ];
      const table = document.createElement('table');
      table.className = 'kbd-table';
      for (const [k1, k2] of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.innerHTML = this._kbd(k1);
        const td2 = document.createElement('td');
        td2.textContent = t.t(k2 + '');
        tr.append(td1, td2);
        table.appendChild(tr);
      }
      body.appendChild(table);
    },
  };

  _kbd(key) {
    const map = {
      arrows: '←↑↓→', shiftArrows: 'Shift + ←↑↓→', ctrlArrows: 'Ctrl + ←/→',
      homeEnd: 'Home / End', ctrlHomeEnd: 'Ctrl + Home/End', page: 'Page Up/Down',
      ctrlZ: '<kbd>Ctrl</kbd>+<kbd>Z</kbd>', ctrlY: '<kbd>Ctrl</kbd>+<kbd>Y</kbd>',
      ctrlFind: '<kbd>Ctrl</kbd>+<kbd>F</kbd>', ctrlS: '<kbd>Ctrl</kbd>+<kbd>S</kbd>',
      ctrlN: '<kbd>Ctrl</kbd>+<kbd>N</kbd>', ctrlO: '<kbd>Ctrl</kbd>+<kbd>O</kbd>',
      ctrlA: '<kbd>Ctrl</kbd>+<kbd>A</kbd>', ctrlK: '<kbd>Ctrl</kbd>+<kbd>K</kbd>',
      ctrlIp: '<kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>−</kbd>', f11: '<kbd>F11</kbd>',
      ctrlSlash: '<kbd>Ctrl</kbd>+<kbd>/</kbd>', ctrlShiftM: '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>',
      ctrlG: '<kbd>Ctrl</kbd>+<kbd>G</kbd>',
    };
    return map[key] || key;
  }

  /* ============================================================
     Find & Replace
     ============================================================ */

  _makeFind() {
    const api = {};
    let open = false;
    let matches = [];
    let active = -1;

    const els = {
      bar: document.getElementById('findbar'),
      inp: document.getElementById('fb-find'),
      rep: document.getElementById('fb-replace'),
      count: document.getElementById('fb-count'),
      prev: document.getElementById('fb-prev'),
      next: document.getElementById('fb-next'),
      close: document.getElementById('fb-close'),
      case: document.getElementById('fb-case'),
      word: document.getElementById('fb-word'),
      regex: document.getElementById('fb-regex'),
      repl1: document.getElementById('fb-replace1'),
      replAll: document.getElementById('fb-replaceall'),
    };

    const onInput = () => api.update();
    els.inp.addEventListener('input', onInput);
    els.case.addEventListener('change', onInput);
    els.word.addEventListener('change', onInput);
    els.regex.addEventListener('change', onInput);

    els.prev.addEventListener('click', () => api.prev());
    els.next.addEventListener('click', () => api.next());
    els.close.addEventListener('click', () => api.close());
    els.repl1.addEventListener('click', () => api.replaceCurrent());
    els.replAll.addEventListener('click', () => api.replaceAll());

    api.open = () => {
      const doc = this.getActiveDoc();
      if (!doc) return;
      open = true;
      els.bar.classList.remove('hidden');
      if (!els.inp.value && doc.selection.end > doc.selection.start) {
        els.inp.value = doc.buffer.getText(doc.selection.start, doc.selection.end - doc.selection.start);
      }
      els.inp.focus();
      els.inp.select();
      this._renderStatic();
      api.update();
    };
    api.isOpen = () => open;
    api.close = () => {
      open = false;
      els.bar.classList.add('hidden');
      this.renderer.setMatches([]);
      this.input.focusEditor();
    };
    api._renderStatic = () => {
      els.count.textContent = '';
    };
    api.getMatches = () => matches;

    api.update = () => {
      const doc = this.getActiveDoc();
      if (!doc) return;
      const q = els.inp.value;
      if (!q) { matches = []; active = -1; this.renderer.setMatches([]); els.count.textContent = i18n.t('noResults'); return; }
      matches = findInDoc(doc, q, {
        caseSensitive: els.case.checked,
        wholeWord: els.word.checked,
        regex: els.regex.checked,
      });
      if (!matches.length) {
        active = -1;
        this.renderer.setMatches([]);
        els.count.textContent = i18n.t('noResults');
        return;
      }
      // active = first match at/after cursor
      const cursorOff = doc.buffer.lineColumnToOffset(doc.cursor.line, doc.cursor.column);
      active = 0;
      for (let i = 0; i < matches.length; i++) if (matches[i].end >= cursorOff || matches[i].start >= cursorOff) { active = i; break; }
      this.renderer.setMatches(matches, active);
      els.count.textContent = i18n.t('resultsCount', { n: formatNumber(matches.length) }) + ` · ${active + 1}/${matches.length}`;
      this._jumpToMatch(active);
    };

    api.next = () => {
      if (!matches.length) return;
      active = (active + 1) % matches.length;
      this.renderer.setMatches(matches, active);
      this._jumpToMatch(active);
      els.count.textContent = i18n.t('resultsCount', { n: matches.length }) + ` · ${active + 1}/${matches.length}`;
    };
    api.prev = () => {
      if (!matches.length) return;
      active = (active - 1 + matches.length) % matches.length;
      this.renderer.setMatches(matches, active);
      this._jumpToMatch(active);
      els.count.textContent = i18n.t('resultsCount', { n: matches.length }) + ` · ${active + 1}/${matches.length}`;
    };

    api._jumpToMatch = (i) => {
      const doc = this.getActiveDoc();
      if (!doc || !matches[i]) return;
      const m = matches[i];
      const lc = doc.buffer.offsetToLineColumn(m.start);
      doc.cursor.setPosition(lc.line, lc.column, { resetGoal: true });
      doc.setSelection(m.start, m.end);
      this.renderer.setSelection(doc.selection);
      this.renderer.moveCursorTo(doc.cursor);
      this._placeProxy();
      this.updateStatus(true);
    };

    api.replaceCurrent = () => {
      const doc = this.getActiveDoc();
      if (!doc) return;
      const m = matches[active];
      if (!m) return;
      const rep = els.rep.value || '';
      doc.replaceRange(m.start, m.end, rep);
      this.afterEdit(m.start, rep.length);
      this.updateStatus(true);
      api.update();
    };

    api.replaceAll = () => {
      const doc = this.getActiveDoc();
      if (!doc || !matches.length) return;
      const rep = els.rep.value || '';
      doc.replaceAllMatches(matches, rep, { regex: els.regex.checked });
      this.afterEdit(matches[0].start, rep.length);
      this.updateStatus(true);
      api.update();
    };

    return api;
  }

  /* ============================================================
     Side pane: outline + markdown preview
     ============================================================ */

  toggleOutline() {
    const sp = document.getElementById('sidepane');
    const op = document.getElementById('outline-pane');
    const pp = document.getElementById('preview-pane');
    if (!sp.classList.contains('hidden')) {
      this._refreshSidePane(true);
      if (op.classList.contains('hidden')) {
        op.classList.remove('hidden');
        pp.classList.add('hidden');
        this._renderOutline();
      } else {
        sp.classList.add('hidden');
      }
    } else {
      sp.classList.remove('hidden');
      op.classList.remove('hidden');
      pp.classList.add('hidden');
      this._renderOutline();
    }
  }

  togglePreview() {
    const sp = document.getElementById('sidepane');
    const op = document.getElementById('outline-pane');
    const pp = document.getElementById('preview-pane');
    if (!sp.classList.contains('hidden')) {
      if (pp.classList.contains('hidden')) {
        pp.classList.remove('hidden');
        op.classList.add('hidden');
        this._renderPreview();
      } else {
        sp.classList.add('hidden');
      }
    } else {
      sp.classList.remove('hidden');
      pp.classList.remove('hidden');
      op.classList.add('hidden');
      this._renderPreview();
    }
  }

  _refreshSidePane(force) {
    if (force) return;
    const sp = document.getElementById('sidepane');
    if (sp.classList.contains('hidden')) return;
    const op = document.getElementById('outline-pane');
    const pp = document.getElementById('preview-pane');
    if (!op.classList.contains('hidden')) this._renderOutline();
    if (!pp.classList.contains('hidden')) this._renderPreview();
  }

  _renderOutline() {
    const doc = this.getActiveDoc();
    const pane = document.getElementById('outline-pane');
    if (!doc) return;
    pane.textContent = '';
    const header = document.createElement('div');
    header.className = 'pane-header';
    header.textContent = i18n.t('outline');
    const close = document.createElement('button');
    close.className = 'icon-btn';
    close.innerHTML = icons.close;
    close.addEventListener('click', () => document.getElementById('sidepane').classList.add('hidden'));
    header.appendChild(close);
    pane.appendChild(header);

    const text = doc.buffer.getText();
    const lines = text.split('\n');
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,3})\s+(.*)$/);
      if (m) items.push({ level: m[1].length, title: m[2], line: i });
    }
    if (!items.length) {
      const es = document.createElement('div');
      es.className = 'empty-state';
      es.textContent = i18n.t('outline') + ' — ' + i18n.t('noResults');
      pane.appendChild(es);
      return;
    }
    for (const it of items) {
      const el = document.createElement('div');
      el.className = `outline-item h${it.level}`;
      el.textContent = it.title;
      el.addEventListener('click', () => {
        const off = doc.buffer.lineColumnToOffset(it.line, 0);
        const p = this.renderer.offsetToPx(off);
        this.renderer.viewport.scrollTop = Math.max(0, p.y);
        const lc = doc.buffer.offsetToLineColumn(off);
        doc.cursor.setPosition(lc.line, 0, { resetGoal: true });
        doc.setSelection(off, off);
        this.afterMove();
        this.input.focusEditor();
      });
      pane.appendChild(el);
    }
  }

  _renderPreview() {
    const doc = this.getActiveDoc();
    const pane = document.getElementById('preview-pane');
    if (!doc) return;
    pane.textContent = '';
    const header = document.createElement('div');
    header.className = 'pane-header';
    header.textContent = i18n.t('preview');
    const close = document.createElement('button');
    close.className = 'icon-btn';
    close.innerHTML = icons.close;
    close.addEventListener('click', () => document.getElementById('sidepane').classList.add('hidden'));
    header.appendChild(close);
    pane.appendChild(header);
    const content = document.createElement('div');
    content.innerHTML = this._markdown(doc.buffer.getText());
    pane.appendChild(content);
  }

  /** Tiny hand-rolled Markdown → HTML (no dependencies). */
  _markdown(src) {
    const { escapeHtml } = { escapeHtml: (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
    const lines = src.split('\n');
    const out = [];
    let inCode = false, codeBuf = [], inUl = false, inOl = false;

    const closeList = () => {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
    };
    const inline = (s) => s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        if (inCode) {
          out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
          codeBuf = []; inCode = false;
        } else {
          closeList(); out.push('<pre>'); codeBuf = []; inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeList(); out.push(`<h${h[1].length}>${inline(escapeHtml(h[2]))}</h${h[1].length}>`); continue; }
      if (/^\s*[-*]\s+/.test(line)) {
        if (!inUl) { out.push('<ul>'); inUl = true; }
        out.push(`<li>${inline(escapeHtml(line.replace(/^\s*[-*]\s+/, '')))}</li>`);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        if (!inOl) { out.push('<ol>'); inOl = true; }
        out.push(`<li>${inline(escapeHtml(line.replace(/^\s*\d+\.\s+/, '')))}</li>`);
        continue;
      }
      if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }
      if (/^&gt;/.test(line) || /^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(escapeHtml(line.replace(/^>\s?/, '')))}</blockquote>`); continue; }
      if (!line.trim()) { closeList(); out.push(''); continue; }
      closeList();
      out.push(`<p>${inline(escapeHtml(line))}</p>`);
    }
    closeList();
    if (inCode) out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
    return out.join('\n');
  }

  /* ============================================================
     Statistics modal
     ============================================================ */

  showStatistics() {
    const doc = this.getActiveDoc();
    if (!doc) return;
    const t = i18n;
    const modal = this._makeModal();
    modal.querySelector('.modal-title').textContent = t.t('statisticsTitle');
    const body = modal.querySelector('.modal-body');
    const text = doc.buffer.getText();
    const words = (text.match(/\S+/g) || []);
    const freq = {};
    for (const w of words) {
      const clean = w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
      if (clean.length > 1) freq[clean] = (freq[clean] || 0) + 1;
    }
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const chars = {};
    for (const ch of text.split('')) {
      if (/\s/.test(ch)) continue;
      chars[ch] = (chars[ch] || 0) + 1;
    }
    const topChars = Object.entries(chars).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const html = `
      <h4>${t.t('words')}: ${formatNumber(words.length)} · ${t.t('chars')}: ${formatNumber(text.length)} · ${t.t('linesStatus')}: ${formatNumber(doc.buffer.getLineCount())}</h4>
      <h4 style="margin-top:18px">${t.t('topWords')}</h4>
      <ul style="line-height:1.8">${top.map(([w, c]) => `<li><span style="font-weight:600">${escapeHtml(w)}</span> — ${c}</li>`).join('')}</ul>
      <h4 style="margin-top:18px">${t.t('charDist')}</h4>
      <ul style="line-height:1.8">${topChars.map(([w, c]) => `<li><code>${escapeHtml(w)}</code> — ${c}</li>`).join('')}</ul>`;
    body.innerHTML = html;
  }

  /* ============================================================
     Versions modal
     ============================================================ */

  async showVersions() {
    const doc = this.getActiveDoc();
    if (!doc) return;
    const t = i18n;
    const modal = this._makeModal();
    modal.querySelector('.modal-title').textContent = t.t('restoreVersionTitle', { name: doc.title });
    const body = modal.querySelector('.modal-body');
    const list = document.createElement('div');
    body.appendChild(list);
    const v = await storage.loadVersions(doc.id);
    if (!v.length) { list.innerHTML = `<div class="empty-state">${t.t('noResults')}</div>`; return; }
    const rel = (ts) => {
      const d = Date.now() - ts;
      if (d < 60000) return t.t('justNow');
      if (d < 3600000) return t.t('minutesAgo', { m: Math.round(d / 60000) });
      if (d < 86400000) return t.t('hoursAgo', { h: Math.round(d / 3600000) });
      return t.t('daysAgo', { d: Math.round(d / 86400000) });
    };
    const boxes = [];
    for (const ver of v.slice(0, 30)) {
      const item = document.createElement('div');
      item.className = 'version-item';
      const meta = document.createElement('div');
      meta.className = 'version-meta';
      const time = document.createElement('span');
      time.className = 'version-time';
      time.textContent = new Date(ver.ts).toLocaleString();
      const desc = document.createElement('span');
      desc.className = 'version-desc';
      desc.textContent = `${rel(ver.ts)} · ${formatNumber(ver.text.length)} chars`;
      meta.append(time, desc);
      const btn = document.createElement('button');
      btn.className = 'text-btn primary';
      btn.textContent = t.t('restore');
      btn.addEventListener('click', async () => {
        doc.replaceRange(0, doc.buffer.getTotalLength(), ver.text);
        this.afterEdit(0, ver.text.length);
        this.toast('toastRestoredVersion', { vars: { time: new Date(ver.ts).toLocaleString() } });
        this.saveNow();
        modal.closest('.overlay').remove();
      });
      item.append(meta, btn);
      list.appendChild(item);
      boxes.push(item);
    }
    void boxes;
  }

  /* ============================================================
     Recents modal
     ============================================================ */

  async showRecents() {
    const t = i18n;
    const modal = this._makeModal();
    modal.querySelector('.modal-title').textContent = t.t('recentTitle');
    const body = modal.querySelector('.modal-body');
    const recents = await storage.loadRecents();
    const list = document.createElement('div');
    body.appendChild(list);
    if (!recents.length) { list.innerHTML = `<div class="empty-state">${t.t('noResults')}</div>`; return; }
    for (const r of recents.slice(0, 20)) {
      const item = document.createElement('div');
      item.className = 'recent-item';
      const meta = document.createElement('div');
      meta.innerHTML = `<strong>${escapeHtml(r.name)}</strong><br><small style="color:var(--color-text-dim)">${new Date(r.ts).toLocaleString()}</small>`;
      item.appendChild(meta);
      item.addEventListener('click', () => {
        if (this.docs.has(r.id)) {
          this._activate(r.id);
        } else {
          this.toast('toastNoFile', { type: 'warning' });
        }
        modal.closest('.overlay').remove();
      });
      list.appendChild(item);
    }
    const clear = document.createElement('button');
    clear.className = 'text-btn';
    clear.style.marginTop = '12px';
    clear.textContent = t.t('clearHistory');
    clear.addEventListener('click', async () => { await storage.clearRecents(); this.toast('toastClearRecents'); location.reload(); });
    body.appendChild(clear);
  }

  /* ============================================================
     Focus mode
     ============================================================ */

  toggleFocusMode() {
    this.focusMode = !this.focusMode;
    const app = document.getElementById('app');
    app.dataset.view = this.focusMode ? 'focus' : 'edit';
    if (this.focusMode) {
    } else {
      this.input.focusEditor();
    }
  }

  /* ============================================================
     AI integration
     ============================================================ */

  setAIPanelOpen(open) {
    const app = document.getElementById('app');
    app.classList.toggle('ai-closed', !open);
    if (this.ai && this.ai.panel) this.ai.panel.classList.toggle('open', open);
    if (this.ai) this.ai.panelOpen = open;
    LSS('aiPanelOpen', open);
    this._placeProxy();
  }

  /** Insert AI-suggested text as ONE undoable command. */
  insertAIText(text) {
    const doc = this.getActiveDoc();
    if (!doc || !text) return;
    const sel = doc.getSelectionOffsets();
    if (sel.end > sel.start) {
      doc.replaceRange(sel.start, sel.end, text);
      this.afterEdit(sel.start, text.length);
      this.renderer.setSelection(doc.selection);
    } else {
      const ins = new InsertTextCommand(sel.start, text);
      doc._apply(ins);
      this.afterEdit(sel.start, text.length);
    }
    this.toast('aiInserted', { type: 'success' });
    this.saveNow();
  }

  /* ============================================================
     Toasts & misc UI
     ============================================================ */

  toast(key, opts = {}) {
    const t = i18n;
    const cont = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (opts.type ? ' ' + opts.type : '');
    el.textContent = t.t(key, opts.vars || {});
    cont.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 200);
    }, 2600);
  }

  showDragOverlay(on) {
    this.dragOverlayEl.classList.toggle('hidden', !on);
  }

  /* ============================================================
     First-run tour
     ============================================================ */

  _startTour() {
    const t = i18n;
    const steps = [
      { title: 'tour1Title', body: 'tour1Body', target: '#viewport' },
      { title: 'tour2Title', body: 'tour2Body', target: '#btn-new' },
      { title: 'tour3Title', body: 'tour3Body', target: '#btn-ai-toggle' },
      { title: 'tour4Title', body: 'tour4Body', target: '.lang-switch' },
      { title: 'tour5Title', body: 'tour5Body', target: '#btn-help' },
    ];
    let idx = 0;
    const tourEl = document.getElementById('tour');
    tourEl.classList.remove('hidden');

    const render = () => {
      tourEl.textContent = '';
      const s = steps[idx];
      const target = document.querySelector(s.target);
      const bubble = document.createElement('div');
      bubble.className = 'tour-bubble';
      bubble.innerHTML = `
        <div class="tour-step">${t.t('tourStep', { a: idx + 1, b: steps.length })}</div>
        <div class="tour-title">${t.t(s.title)}</div>
        <div>${t.t(s.body)}</div>
        <div class="tour-actions">
          <button class="text-btn" id="tour-skip">${t.t('tourSkip')}</button>
          ${idx < steps.length - 1 ? `<button class="text-btn primary" id="tour-next">${t.t('tourNext')}</button>` : `<button class="text-btn primary" id="tour-next">${t.t('tourDone')}</button>`}
        </div>`;
      tourEl.appendChild(bubble);
      bubble.querySelector('#tour-skip').addEventListener('click', finish);
      bubble.querySelector('#tour-next').addEventListener('click', () => {
        idx++;
        if (idx >= steps.length) finish();
        else render();
      });
      if (target) {
        const hl = document.createElement('div');
        hl.className = 'tour-highlight';
        const r = target.getBoundingClientRect();
        Object.assign(hl.style, { left: r.left - 4 + 'px', top: r.top - 4 + 'px', width: r.width + 8 + 'px', height: r.height + 8 + 'px' });
        tourEl.appendChild(hl);
        let bx = r.left + r.width / 2 - 140;
        let by = r.bottom + 12;
        bx = Math.max(12, Math.min(bx, window.innerWidth - 300));
        if (by + 170 > window.innerHeight) by = Math.max(12, r.top - 170);
        bubble.style.left = bx + 'px';
        bubble.style.top = by + 'px';
      }
      bubble.querySelector('#tour-next').focus();
    };
    const finish = () => {
      tourEl.classList.add('hidden');
      tourEl.textContent = '';
      LSS('tourSeen', true);
    };
    render();
  }
}

/* Boot box */
window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  window.__app = app; // debugging convenience
app.boot().catch((e) => {
      console.error('boot failed', e);
      // Editor still works: create a blank document inline.
      document.getElementById('status-save').textContent = 'ERR';
    });
});