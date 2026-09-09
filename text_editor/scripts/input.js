/* ============================================================
   input.js — translates raw keyboard / mouse / IME events into
   Commands, and moves the cursor.

   TEXT ENTRY STRATEGY
   -------------------
   The editor caret is our own DOM element, but translating every
   possible input event (IME composition, Arabic keyboard, emoji
   picker, mobile virtual keyboards, dead keys…) yourself is a
   losing battle. Instead we keep a tiny nearly-invisible textarea
   ("input-proxy") parked exactly at the caret and OUT of the
   user's visual view. All text entry funnels through it:
     - beforeinput 'insertText'/'insertLineBreak' → insert,
     - compositionstart/end (IME) → insert the composed string,
     - 'paste' → clipboard text via ReplaceSelectionCommand.
   The proxy is reset after each event so we don't accumulate
   ghost text. Native shortcuts (Bold via Ctrl+B, etc.) are all
   prevented and handled by us.

   EVERY edit goes through history.push / a typing group → every
   edit is undoable (see history.js).
   ============================================================ */

import {
  nextGrapheme, prevGrapheme, isWordCharAt, isArabicCharCode,
  detectLineDirection, clamp,
} from './util.js';
import { InsertTextCommand, ReplaceSelectionCommand } from './commands.js';

export class InputController {
  constructor(app) {
    this.app = app;
    this._mouseState = null;
    this._lastHomeEnd = 0;
    this._lastHomeEndWasStart = false;
    this._groupTimer = null;
    this.composing = false;
    this._selecting = false;
    this._dragScrollRAF = null;
  }

  get doc() { return this.app.getActiveDoc(); }
  get renderer() { return this.app.renderer; }

  attach() {
    this._proxy = document.getElementById('input-proxy');

    document.addEventListener('keydown', (e) => this._onKeyDown(e), true);
    document.addEventListener('mousedown', (e) => this._onMouseDown(e));
    document.addEventListener('mouseup', (e) => this._onMouseUp(e));
    document.addEventListener('mousemove', (e) => this._onMouseMove(e));
    document.addEventListener('dblclick', (e) => this._onDoubleClick(e));
    document.addEventListener('dragover', (e) => this._onDragOver(e));
    document.addEventListener('drop', (e) => this._onDrop(e));

    this._proxy.addEventListener('beforeinput', (e) => this._onBeforeInput(e));
    this._proxy.addEventListener('compositionstart', () => { this.composing = true; this._commitGroup(); });
    this._proxy.addEventListener('compositionend', (e) => { this.composing = false; this._flushProxy(); });
    this._proxy.addEventListener('paste', (e) => this._onProxyPaste(e));
    this._proxy.addEventListener('copy', (e) => this._onProxyCopyCut(e, false));
    this._proxy.addEventListener('cut', (e) => this._onProxyCopyCut(e, true));
    this._proxy.addEventListener('input', () => this._flushProxy());
    this._proxy.addEventListener('focus', () => document.body.classList.add('using-keyboard'));
    this._proxy.addEventListener('blur', () => document.body.classList.remove('using-keyboard'));

    if ('onmousedown' in window) {
      const touch = 'ontouchstart' in window;
      if (touch) {
        this.renderer.viewport.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
      }
    }
  }

  focusEditor() {
    const d = this.doc;
    if (!d) return;
    document.body.classList.add('using-keyboard');
    // Place the caret + proxy at the cursor.
    this.app.paintCaret();
    const { x, y } = this._caretPx();
    this.renderer.positionInputProxy(x, y);
    this._proxy.focus({ preventScroll: true });
    if (typeof this._proxy.scrollIntoView === 'function') {
      // keep the proxy visually parked; don't scroll the page
    }
  }

  _focusProxy() {
    if (!this._proxy) this._proxy = document.getElementById('input-proxy');
    const d = this.doc;
    if (!d) return;
    this.app.paintCaret();
    const { x, y } = this._caretPx();
    this.renderer.positionInputProxy(x, y);
    this._proxy.focus({ preventScroll: true });
  }

  _caretPx() {
    const d = this.doc;
    const off = d.buffer.lineColumnToOffset(d.cursor.line, d.cursor.column);
    const p = this.renderer.offsetToPx(off);
    return { x: p.x, y: p.y };
  }

  /* ---------------- Typing group management ---------------- */

  _beginGroup() {
    const h = this.doc.history;
    h.beginGroup();
    clearTimeout(this._groupTimer);
  }

  _commitGroup() {
    const h = this.doc.history;
    if (h.endGroup()) this.app.historyChanged();
    clearTimeout(this._groupTimer);
  }

  _armGroupTimer() {
    clearTimeout(this._groupTimer);
    this._groupTimer = setTimeout(() => this._commitGroup(), 700);
  }

  /** Insert text (from beforeinput / IME / paste-without-command). */
  insertText(text) {
    const d = this.doc;
    if (!text) return;
    const h = d.history;
    const fresh = !h.isGroupOpen;
    const sel = d.getSelectionOffsets();
    h.beginGroup();
    let cmd;
    if (fresh && sel.end > sel.start) {
      // First keystroke of a burst: replace the active selection once.
      cmd = new ReplaceSelectionCommand(sel, text);
    } else if (sel.end > sel.start) {
      cmd = new ReplaceSelectionCommand(sel, text);
    } else {
      cmd = new InsertTextCommand(sel.start, text);
    }
    cmd.execute(d);
    h.openGroup.add(cmd);
    this.app.afterEdit(sel.start, text);
    this._armGroupTimer();
  }

  /* ---------------- Event handlers ---------------- */

  _onKeyDown(e) {
    const d = this.doc;
    if (!d) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const handled = this._dispatchShortcut(e, mod, e.shiftKey, key);
    if (handled === true) {
      e.preventDefault();
      if (mod || ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(key)) {
        this._commitGroup();
      }
    }
  }

  _dispatchShortcut(e, mod, shift, key) {
    const app = this.app;
    const d = this.doc;

    // --- Text-producing keys handled natively by the proxy ---
    if (key === 'Unidentified' && this.composing) return true;

    // Application shortcuts
    if (mod) {
      const k = key.toLowerCase();
      switch (k) {
        case 'z':
          if (shift) d.redo(); else d.undo();
          this._commitGroup();
          return true;
        case 'y': d.redo(); this._commitGroup(); return true;
        case 'a': this.selectAll(); return true;
        case 'n': app.newDocument(); return true;
        case 'o': e.preventDefault(); app.openFile(); return true;
        case 's': app.exportCurrent(); return true;
        case 'f': app.find.open(); return true;
        case 'k': app.ai.togglePanel(); return true;
        case '/': app.help.show(); return true;
        case 'm': if (shift) { app.togglePreview(); return true; } break;
        case 'g': app.toggleOutline(); return true;
        case 'b': if (app.ai.panelOpen) { app.ai.togglePanel(); return true; } break;
        case '=': case '+': app.zoomIn(); return true;
        case '-': case '_': app.zoomOut(); return true;
        case '0': app.resetZoom(); return true;
      }
      return false;
    }

    if (key === 'F11') { e.preventDefault(); app.toggleFocusMode(); return true; }

    // -- Caret / editing keys --
    switch (key) {
      case 'Backspace':
        this._commitGroup();
        this.autoIndentIfNeeded();
        d.deleteBefore();
        this._afterEditAction();
        return true;
      case 'Delete':
        this._commitGroup();
        d.deleteAfter();
        this._afterEditAction();
        return true;
      case 'Enter': case 'NumpadEnter':
        // handled via beforeinput insertLineBreak; nothing here
        return false;
      case 'Tab':
        if (!shift) {
          this.insertText('\t');
          return true;
        }
        e.preventDefault();
        return true;
      case 'ArrowLeft': this.moveHoriz(-1, shift); return true;
      case 'ArrowRight': this.moveHoriz(1, shift); return true;
      case 'ArrowUp': this.moveVert(-1, shift); return true;
      case 'ArrowDown': this.moveVert(1, shift); return true;
      case 'Home':
        if (mod) { this.moveToDocStart(shift); return true; }
        this.homeEnd(false, shift); return true;
      case 'End':
        if (mod) { this.moveToDocEnd(shift); return true; }
        this.homeEnd(true, shift); return true;
      case 'PageUp':
        if (mod) { this.moveToDocStart(shift); return true; }
        this.movePage(-1, shift); return true;
      case 'PageDown':
        if (mod) { this.moveToDocEnd(shift); return true; }
        this.movePage(1, shift); return true;
    }

    if (mod && key === 'ArrowLeft') { this.moveWord(-1, shift); return true; }
    if (mod && key === 'ArrowRight') { this.moveWord(1, shift); return true; }

    return false;
  }

  _onBeforeInput(e) {
    const d = this.doc;
    if (!d) return;
    if (this.composing) { e.preventDefault(); return; } // IME handles text
    const t = e.inputType;
    if (t === 'insertText' || t === 'insertLineBreak' || t === 'insertParagraph' || t === 'insertFromPaste' || t === 'insertCompositionText') {
      e.preventDefault();
      let text = '';
      if (e.data != null) text = e.data;
      else if (t === 'insertLineBreak' || t === 'insertParagraph') text = '\n';
      if (t === 'insertCompositionText') { /* handled by compositionend */ return; }
      if (text) {
        this._beginGroup();
        this.insertText(text);
      }
    } else if (t === 'deleteContentBackward' || t === 'deleteContentForward' || t === 'deleteWordBackward' || t === 'deleteWordForward') {
      e.preventDefault();
      this._commitGroup();
      if (t === 'deleteWordBackward') d.deleteWordBefore();
      else if (t === 'deleteWordForward') d.deleteWordAfter();
      else if (t === 'deleteContentBackward') d.deleteBefore();
      else d.deleteAfter();
      this._afterEditAction();
    }
  }

  _flushProxy() {
    const p = this._proxy;
    if (this.composing) return;
    const val = p.value;
    if (val && val.length) {
      this.insertText(val);
    }
    p.value = '';
  }

  _onProxyPaste(e) {
    e.preventDefault();
    const d = this.doc;
    if (!d) return;
    this._commitGroup();
    let text = '';
    if (e.clipboardData && e.clipboardData.getData) {
      text = e.clipboardData.getData('text/plain');
    }
    if (!text && navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then((t) => {
        if (t) this.insertText(t);
        this._afterEditAction();
      }).catch(() => this.app.toast('toastCantPaste', { type: 'warning' }));
      return;
    }
    if (text) { this.insertText(text); this._afterEditAction(); }
  }

  _onProxyCopyCut(e, cut) {
    const d = this.doc;
    if (!d) return;
    const sel = d.getSelectionOffsets();
    if (sel.end <= sel.start) return;
    const text = d.buffer.getText(sel.start, sel.end - sel.start);
    e.preventDefault();
    if (e.clipboardData && e.clipboardData.setData) {
      e.clipboardData.setData('text/plain', text);
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => this.app.toast('toastCantPaste', { type: 'warning' }));
    }
    if (cut) {
      this._commitGroup();
      d.replaceRange(sel.start, sel.end, '');
      this._afterEditAction();
    }
  }

  /* ---------------- Movement ---------------- */

  _curOffset() {
    const d = this.doc;
    return d.buffer.lineColumnToOffset(d.cursor.line, d.cursor.column);
  }

  _lineDirection(lineIdx) {
    const d = this.doc;
    const text = d.buffer.getLine(lineIdx);
    let dir = detectLineDirection(text);
    if (dir === 'neutral') dir = d.dir === 'rtl' ? 'rtl' : 'ltr';
    return dir;
  }

  /** Character under/in-front-of the cursor, for run-direction. */
  _runDirAt(offset) {
    const d = this.doc;
    const { line, column } = d.buffer.offsetToLineColumn(offset);
    const text = d.buffer.getLine(line);
    const ch = text[Math.min(column, text.length - 1)];
    if (ch && isArabicCharCode(ch.codePointAt(0))) return 'rtl';
    const ch2 = column < text.length ? text[column] : (text[column - 1] || '');
    if (ch2 && isArabicCharCode(ch2.codePointAt(0))) return 'rtl';
    return this._lineDirection(line);
  }

  moveHoriz(dir, shift) {
    const d = this.doc;
    const startOff = this._curOffset();
    const runDir = this._runDirAt(startOff);
    const lineText = d.buffer.getLine(d.buffer.offsetToLineColumn(startOff).line);
    const isRtl = runDir === 'rtl';
    let off;
    if (dir === 1) {
      // visually right: in RTL that's logical previous
      off = isRtl ? this._prevGraphemeOffset(startOff) : this._nextGraphemeOffset(startOff);
    } else {
      off = isRtl ? this._nextGraphemeOffset(startOff) : this._prevGraphemeOffset(startOff);
    }
    void lineText;
    this._finishMove(off, shift);
  }

  moveWord(dir, shift) {
    const d = this.doc;
    const startOff = this._curOffset();
    const runDir = this._runDirAt(startOff);
    const isRtl = runDir === 'rtl';
    const text = d.buffer.getText();
    // jump direction in logical terms
    const logicalDir = (dir === 1) !== isRtl ? 1 : -1;
    let off = startOff;
    if (logicalDir === 1) off = this._nextWordOffset(startOff);
    else off = this._prevWordOffset(startOff);
    void text;
    this._finishMove(off, shift);
  }

  _prevGraphemeOffset(off) {
    const d = this.doc;
    if (off <= 0) return 0;
    const { line, column } = d.buffer.offsetToLineColumn(off);
    const text = d.buffer.getLine(line);
    if (column === 0) {
      if (line === 0) return 0;
      const prevLine = d.buffer.getLine(line - 1);
      return d.buffer.lineColumnToOffset(line - 1, prevLine.length);
    }
    const nc = prevGrapheme(text, column);
    return d.buffer.lineColumnToOffset(line, nc);
  }

  _nextGraphemeOffset(off) {
    const d = this.doc;
    const { line, column } = d.buffer.offsetToLineColumn(off);
    const text = d.buffer.getLine(line);
    if (column >= text.length) {
      const end = d.buffer.lineEndOf(off);
      return Math.min(end, d.buffer.getTotalLength());
    }
    const n = nextGrapheme(text, column);
    if (text[n] === '\n' || n > text.length) { /* n/a */ }
    // clamp: if n lands past the line text, stay at line end
    return d.buffer.lineColumnToOffset(line, Math.min(n, text.length));
  }

  _prevWordOffset(off) {
    const d = this.doc;
    const { line, column } = d.buffer.offsetToLineColumn(off);
    const text = d.buffer.getLine(line);
    let i = column;
    if (i > 0 && isWordCharAt(text, i - 1)) {
      while (i > 0 && isWordCharAt(text, i - 1)) i--;
    } else {
      while (i > 0 && !isWordCharAt(text, i - 1) && text[i - 1] !== '\n') i--;
    }
    if (i === 0 && line > 0) {
      const prev = d.buffer.getLine(line - 1);
      let j = prev.length;
      while (j > 0 && isWordCharAt(prev, j - 1)) j--;
      return d.buffer.lineColumnToOffset(line - 1, j);
    }
    return d.buffer.lineColumnToOffset(line, i);
  }

  _nextWordOffset(off) {
    const d = this.doc;
    const { line, column } = d.buffer.offsetToLineColumn(off);
    const text = d.buffer.getLine(line);
    let i = column;
    while (i < text.length && !isWordCharAt(text, i)) i++;
    while (i < text.length && isWordCharAt(text, i)) i++;
    return d.buffer.lineColumnToOffset(line, i);
  }

  moveVert(dir, shift) {
    const d = this.doc;
    const off = this._curOffset();
    const target = this.renderer.moveVertically(off, dir);
    this._finishMove(target, shift);
  }

  movePage(dir, shift) {
    const d = this.doc;
    const off = this._curOffset();
    const rows = Math.max(1, Math.floor(this.renderer.viewportH / (this.renderer.rowHeight || 16)) - 1);
    let target = off;
    for (let i = 0; i < rows; i++) {
      const t2 = this.renderer.moveVertically(target, dir);
      if (t2 === target) break;
      target = t2;
    }
    this._finishMove(target, shift);
  }

  homeEnd(isEnd, shift) {
    const d = this.doc;
    const now = Date.now();
    const off = this._curOffset();
    const quick = now - this._lastHomeEnd < 400;
    const logical = quick && this._lastHomeEndWasStart === isEnd;
    this._lastHomeEnd = now;
    this._lastHomeEndWasStart = isEnd;

    let target;
    if (logical) {
      if (isEnd) {
        const { line } = d.buffer.offsetToLineColumn(this._curOffset());
        const lineLen = d.buffer.getLineLength(line);
        target = d.buffer.lineColumnToOffset(line, lineLen);
      } else {
        target = d.buffer.lineStartOf(this._curOffset());
      }
    } else {
      target = isEnd ? this.renderer.visualLineEndOffset(off) : this.renderer.visualLineStartOffset(off);
    }
    this._finishMove(target, shift);
  }

  moveToDocStart(shift) { this._finishMove(0, shift); }
  moveToDocEnd(shift) {
    const d = this.doc;
    this._finishMove(d.buffer.getTotalLength(), shift);
  }

  _finishMove(target, shift) {
    const d = this.doc;
    this._commitGroup();
    if (shift) {
      const cur = this._curOffset();
      const sel = d.selection;
      let anchor = (sel && sel.active && sel.end > sel.start) ? sel.anchor : cur;
      if (anchor == null) anchor = cur;
      this._selAnchor = this._selAnchor || anchor;
      d.selection = new (d.selection.constructor)(this._selAnchor, target);
      d.selection.active = true;
    } else {
      this._selAnchor = null;
      const lc = d.buffer.offsetToLineColumn(target);
      d.cursor.setPosition(lc.line, lc.column, { resetGoal: true });
      d.setSelection(null);
    }
    this.app.afterMove();
  }

  /** Replace-all cursor position after an atomic edit. */
  _afterEditAction() {
    this.app.afterEdit(null, null);
  }

  _beforeEditAction(fn) {
    fn();
    this.app.afterEdit(null, null);
  }

  autoIndentIfNeeded() {
    // When deleting an indented line start, keep it simple: no-op.
  }

  selectAll() {
    const d = this.doc;
    this._commitGroup();
    d.setSelection(0, d.buffer.getTotalLength());
    this.app.afterMove();
  }

  /* ---------------- Mouse ---------------- */

  _onMouseDown(e) {
    const app = this.app;
    if (app.ai.panelOpen && e.target.closest('#ai-panel')) return;
    if (e.button !== 0) return;
    const d = this.doc;
    if (!d) return;

    // focus mode click exits
    if (app.focusMode && !e.target.closest('#viewport')) { app.toggleFocusMode(); return; }

    const inViewport = this.renderer.viewport.contains(e.target);
    if (!inViewport && !e.target.closest('#gutter')) return;
    if (e.target.closest('.gutter')) {
      // click on gutter → select that line
      const vp = this.renderer.viewport.getBoundingClientRect();
      const docY = e.clientY - vp.top + this.renderer.scrollTop;
      const globalRow = Math.floor(docY / this.renderer.rowHeight);
      const { line } = this.renderer._locateRow(globalRow);
      if (line == null) return;
      const start = this.renderer.buffer.lineStartOf(this.renderer.buffer.lineColumnToOffset(line, 0));
      const end = this.renderer.buffer.lineEndOf(start);
      d.setSelection(start, end);
      this.app.afterMove();
      return;
    }

    e.preventDefault();
    const off = this.renderer.pxToOffset(e.clientX, e.clientY);
    if (off == null) return;
    this._commitGroup();

    if (e.shiftKey) {
      // extend from existing anchor
      const anchor = d.selection.active && d.selection.end > d.selection.start ? d.selection.anchor : this._curOffset();
      d.setSelection(anchor, off);
    } else {
      d.setSelection(off, off);
      const lc = d.buffer.offsetToLineColumn(off);
      d.cursor.setPosition(lc.line, lc.column, { resetGoal: true });
    }
    this.app.afterMove();

    // Ensure a click always returns keyboard focus to the hidden proxy so
    // subsequent typing is captured (mousedown stealing focus otherwise
    // leaves the editor dead until a manual focusEditor() call).
    this._focusProxy();

    this._selecting = true;
    this._mouseState = { lastX: e.clientX, lastY: e.clientY, anchor: off, mode: 'select' };
    if (e.detail === 2 || e.detail === 3) {
      // handled in dblclick
    }
  }

  _onMouseMove(e) {
    if (!this._selecting || !this._mouseState) return;
    const d = this.doc;
    if (!d) return;
    e.preventDefault();
    this._mouseState.lastX = e.clientX;
    this._mouseState.lastY = e.clientY;
    const off = this.renderer.pxToOffset(e.clientX, e.clientY);
    if (off != null) {
      const sel = d.selection || { anchor: this._mouseState.anchor };
      sel.head = off;
      sel.anchor = this._mouseState.anchor;
      sel.active = true;
      d.selection = sel;
      this.app.afterMove();
    }
    this._autoScroll(e.clientX, e.clientY);
  }

  _onMouseUp() {
    this._selecting = false;
    this._stopAutoScroll();
  }

  _onDoubleClick(e) {
    if (!this.renderer.viewport.contains(e.target)) return;
    const d = this.doc;
    if (!d) return;
    e.preventDefault();
    const off = this.renderer.pxToOffset(e.clientX, e.clientY);
    if (off == null) return;
    if (e.detail === 2) {
      // select word at offset
      const text = d.buffer.getText();
      let s = off, en = off;
      while (s > 0 && isWordCharAt(text, s - 1)) s--;
      while (en < text.length && isWordCharAt(text, en)) en++;
      if (en > s) { d.setSelection(s, en); }
      else { d.setSelection(off, off); }
      this.app.afterMove();
    } else if (e.detail === 3) {
      const { line } = d.buffer.offsetToLineColumn(off);
      const s = d.buffer.lineStartOf(d.buffer.lineColumnToOffset(line, 0));
      const en2 = d.buffer.lineEndOf(s);
      d.setSelection(s, en2);
      this.app.afterMove();
    }
  }

  _onTouchStart(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    this._onMouseDown({ clientX: t.clientX, clientY: t.clientY, button: 0, target: t.target, preventDefault: () => e.preventDefault(), detail: 1, shiftKey: false });
    e.preventDefault();
  }

  _autoScroll(x, y) {
    const vp = this.renderer.viewport;
    const r = vp.getBoundingClientRect();
    const margin = 32;
    let dx = 0, dy = 0;
    if (y < r.top + margin) dy = -6;
    else if (y > r.bottom - margin) dy = 6;
    if (x < r.left + margin) dx = -6;
    else if (x > r.right - margin) dx = 6;
    if (dy === 0 && dx === 0) { this._stopAutoScroll(); return; }
    if (!this._dragScrollRAF) {
      const tick = () => {
        vp.scrollTop += dy * 2;
        vp.scrollLeft += dx * 2;
        this._dragScrollRAF = requestAnimationFrame(tick);
      };
      this._dragScrollRAF = requestAnimationFrame(tick);
    }
  }

  _stopAutoScroll() {
    if (this._dragScrollRAF) { cancelAnimationFrame(this._dragScrollRAF); this._dragScrollRAF = null; }
  }

  /* ---------------- Drag & drop files ---------------- */

  _onDragOver(e) {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      this.app.showDragOverlay(true);
    }
  }

  _onDrop(e) {
    const files = e.dataTransfer && e.dataTransfer.files;
    this.app.showDragOverlay(false);
    if (!files || !files.length) return;
    e.preventDefault();
    const f = files[0];
    if (f) {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        this.app.importDocument(f.name, text);
      };
      reader.readAsText(f);
    }
  }
}

export default InputController;