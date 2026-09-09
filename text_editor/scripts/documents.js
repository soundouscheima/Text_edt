/* ============================================================
   documents.js — one Document = buffer + cursor + selection +
   history + per-doc state + per-doc AI chat.

   These objects are what commands.js operate against: they expose
   `.buffer`, `.cursor`, `.setSelection()` so the Command layer
   stays decoupled from the app chrome.
   ============================================================ */

import { PieceTableBuffer } from './buffer.js';
import { Cursor } from './cursor.js';
import { Selection } from './selection.js';
import { HistoryManager } from './history.js';
import {
  InsertTextCommand, DeleteTextCommand, ReplaceSelectionCommand, CompositeCommand,
} from './commands.js';
import { uid } from './util.js';

let counter = 0;

export class Document {
  constructor(opts = {}) {
    this.id = opts.id || uid('doc_');
    this.title = opts.title || 'Untitled';
    this.createdAt = opts.createdAt || Date.now();
    this.updatedAt = opts.updatedAt || Date.now();
    this.dir = opts.dir || 'auto';          // 'auto' | 'ltr' | 'rtl'
    this.isMarkdown = opts.isMarkdown ?? /\.md$/i.test(this.title);

    this.buffer = opts.buffer || new PieceTableBuffer(opts.text || '');
    this.cursor = opts.cursor ? Cursor.deserialize(opts.cursor) : new Cursor(0, 0);
    this.selection = opts.selection
      ? Selection.deserialize(opts.selection)
      : new Selection(0, 0);
    this.history = new HistoryManager(this, { onChange: () => {
      // repaint undo/redo button states
      if (this._onHistoryChange) this._onHistoryChange(this);
    }, limit: 800 });

    this.chat = opts.chat || [];            // per-doc AI chat history
    this.scrollTop = opts.scrollTop || 0;
    this.scrollLeft = opts.scrollLeft || 0;
    this.dirty = false;
    this.onDirtyChange = null;
    this.onVersionBump = null;
    this._onHistoryChange = null;
    this._snapshotScheduled = false;
  }

  /** Convenience accessors the Command layer expects.
      Passing `null` collapses the selection to the CURRENT caret.
      Passing two offsets sets anchor/head explicitly. */
  setSelection(anchor, head) {
    if (anchor == null) {
      const off = this.buffer.lineColumnToOffset(this.cursor.line, this.cursor.column);
      this.selection = new Selection(off, off);
    } else {
      this.selection = new Selection(anchor, head === undefined ? anchor : head);
    }
  }

  getSelectionOffsets() {
    return { start: this.selection.start, end: this.selection.end };
  }

  get text() { return this.buffer.getText(); }

  setDirty(v) {
    if (this.dirty === v) return;
    this.dirty = v;
    if (this.onDirtyChange) this.onDirtyChange(this);
  }

  _bump() {
    this.updatedAt = Date.now();
    this.setDirty(true);
    // signal renderer to invalidate (app subscribes via onVersionBump)
    if (this.onVersionBump) this.onVersionBump(this);
  }

  /* ---------------- Editing API (goes through commands) ---------------- */

  /** Insert text at the current cursor, replacing any selection. */
  typeText(text) {
    if (!text) return;
    const sel = this.getSelectionOffsets();
    let cmd;
    if (sel.end > sel.start) {
      cmd = new ReplaceSelectionCommand(sel, text);
    } else {
      cmd = new InsertTextCommand(sel.start, text);
    }
    this._apply(cmd);
  }

  /** One undo/redo step that also collapses selection. */
  deleteBefore() {
    const sel = this.getSelectionOffsets();
    if (sel.end > sel.start) {
      this._apply(new ReplaceSelectionCommand(sel, ''));
      return;
    }
    const pos = sel.start;
    if (pos <= 0) return;
    this._apply(new DeleteTextCommand(pos - 1, this.buffer.getText(pos - 1, 1)));
  }

  deleteAfter() {
    const sel = this.getSelectionOffsets();
    if (sel.end > sel.start) {
      this._apply(new ReplaceSelectionCommand(sel, ''));
      return;
    }
    const pos = sel.start;
    if (pos >= this.buffer.getTotalLength()) return;
    this._apply(new DeleteTextCommand(pos, this.buffer.getText(pos, 1)));
  }

  deleteWordBefore() {
    const sel = this.getSelectionOffsets();
    if (sel.end > sel.start) {
      this._apply(new ReplaceSelectionCommand(sel, ''));
      return;
    }
    const pos = this._wordStart(sel.start);
    if (pos === sel.start) return;
    this._apply(new DeleteTextCommand(pos, this.buffer.getText(pos, sel.start - pos)));
  }

  deleteWordAfter() {
    const sel = this.getSelectionOffsets();
    if (sel.end > sel.start) {
      this._apply(new ReplaceSelectionCommand(sel, ''));
      return;
    }
    const pos = this._wordEnd(sel.start);
    if (pos === sel.start) return;
    this._apply(new DeleteTextCommand(sel.start, this.buffer.getText(sel.start, pos - sel.start)));
  }

  _wordStart(offset) {
    const { line, column } = this.buffer.offsetToLineColumn(offset);
    const text = this.buffer.getLine(line);
    let i = column;
    while (i > 0 && !(/\s/u).test(text[i - 1])) i--;
    return this.buffer.lineColumnToOffset(line, i);
  }

  _wordEnd(offset) {
    const { line, column } = this.buffer.offsetToLineColumn(offset);
    const text = this.buffer.getLine(line);
    const lineEnd = this.buffer.lineColumnToOffset(line, text.length);
    let i = column;
    while (i < text.length && !(/\s/u).test(text[i])) i++;
    if (i === text.length) return lineEnd;
    return this.buffer.lineColumnToOffset(line, i);
  }

  /** Replace a range with text as one atomic undoable edit. */
  replaceRange(start, end, replacement) {
    this._apply(new ReplaceSelectionCommand({ start, end }, replacement));
  }

  replaceAllMatches(matches, replacementStr, { regex } = {}) {
    // run as one composite command applied back-to-front
    const cmds = [];
    const buf = this.buffer;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      cmds.push(new ReplaceSelectionCommand({ start: m.start, end: m.end }, replacementStr));
    }
    const composite = new CompositeCommand(cmds);
    composite.execute(this);
    this.history.undoStack.push(composite);
    this.history.redoStack.length = 0;
    this.history._trim();
    this._bump();
    if (this._onHistoryChange) this._onHistoryChange(this);
    void buf; void regex;
  }

  _apply(cmd) {
    cmd.execute(this);
    this.history.undoStack.push(cmd);
    this.history.redoStack.length = 0;
    this.history._trim();
    this._bump();
    if (this._onHistoryChange) this._onHistoryChange(this);
  }

  undo() {
    if (this.history.undo()) this._bump();
  }
  redo() {
    if (this.history.redo()) this._bump();
  }

  /* ---------------- Persistence shape ---------------- */

  serialize() {
    return {
      id: this.id,
      title: this.title,
      text: this.buffer.serialize(),
      cursor: this.cursor.serialize(),
      selection: this.selection.serialize(),
      dir: this.dir,
      isMarkdown: this.isMarkdown,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      scrollTop: this.scrollTop,
      scrollLeft: this.scrollLeft,
      chat: this.chat.slice(-200),
    };
  }
}

/** Search across one (or all) documents for the Find feature. */
export function findInDoc(doc, query, opts = {}) {
  const text = doc.buffer.getText();
  if (!query) return [];
  const matches = [];
  const { caseSensitive = false, wholeWord = false, regex = false } = opts;
  let hay = text;
  let q = query;
  if (!caseSensitive) { hay = hay.toLowerCase(); q = q.toLowerCase(); }
  let re = null;
  let useRegex = regex;
  if (useRegex) {
    try {
      re = new RegExp(q, 'g');
    } catch {
      re = null;
      useRegex = false;
    }
  }
  if (useRegex && re) {
    let m;
    while ((m = re.exec(hay)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (wholeWord && !isWholeWord(hay, start, end)) { if (m[0].length === 0) re.lastIndex++; continue; }
      matches.push({ start, end });
      if (m[0].length === 0) re.lastIndex++; // prevent infinite loop
    }
  } else {
    let idx = hay.indexOf(q);
    while (idx !== -1) {
      const end = idx + q.length;
      if (!wholeWord || isWholeWord(hay, idx, end)) {
        matches.push({ start: idx, end });
      }
      idx = hay.indexOf(q, idx + Math.max(1, q.length));
    }
  }
  return matches;
}

function isWholeWord(hay, start, end) {
  const before = start > 0 ? hay[start - 1] : ' ';
  const after = end < hay.length ? hay[end] : ' ';
  const wc = (c) => c === undefined || !(/[\p{L}\p{N}_]/u).test(c);
  return wc(before) && wc(after);
}

export default { Document, findInDoc };