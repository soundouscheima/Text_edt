/* ============================================================
   commands.js — the Command pattern.

   WHY COMMAND, NOT MEMENTO/STATE-SNAPSHOTS
   -----------------------------------------
   A Memento design would snapshot the entire document state after
   every edit. For a 1 MB document that's ~1 MB per history entry,
   so 500 entries ≈ 500 MB of sealed strings the GC must copy.
   A Command stores only the *diff*: an insert keeps {offset,
   text, piece-state before/after}. Undo replays the reverse
   piece-state with O(pieces) cost and zero text copying (see
   buffer.js). Memory is bounded by edit count, not document size.

   CURSOR SNAPSHOTTING:
   Commands snapshot the cursor BEFORE they are applied (if not
   provided), so undo/redo can restore caret positions exactly.
   After applying, they move the caret to the natural post-edit
   position (insert → after the inserted text, delete → at the
   deletion point). This keeps every command self-contained —
   callers never have to know where the caret should land.
   ============================================================ */

function snapCursor(doc) {
  return { line: doc.cursor.line, column: doc.cursor.column };
}

export class InsertTextCommand {
  constructor(offset, text, opts = {}) {
    this.type = 'insert';
    this.offset = offset;
    this.text = text;
    this.cursorBefore = opts.cursorBefore || null;
    this.desc = null;
  }

  execute(doc) {
    const buf = doc.buffer;
    if (this.cursorBefore == null) this.cursorBefore = snapCursor(doc);
    if (!this.desc) this.desc = buf.insert(this.offset, this.text);
    else buf.redo(this.desc);
    const pos = buf.offsetToLineColumn(this.offset + this.text.length);
    doc.cursor.setPosition(pos.line, pos.column, { resetGoal: true });
    doc.setSelection(null);
  }

  undo(doc) {
    if (this.desc) buf(doc).undo(this.desc);
    _restore(doc, this.cursorBefore, this.offset);
  }

  redo(doc) { this.execute(doc); }
}

export class DeleteTextCommand {
  constructor(offset, text, opts = {}) {
    this.type = 'delete';
    this.offset = offset;
    this.text = text;
    this.cursorBefore = opts.cursorBefore || null;
    this.desc = null;
    this.capturedText = null;
  }

  execute(doc) {
    const buf = doc.buffer;
    if (this.cursorBefore == null) this.cursorBefore = snapCursor(doc);
    if (this.capturedText == null) this.capturedText = buf.getText(this.offset, this.text.length);
    if (!this.desc) this.desc = buf.delete(this.offset, this.capturedText.length);
    else buf.redo(this.desc);
    const pos = buf.offsetToLineColumn(this.offset);
    doc.cursor.setPosition(pos.line, pos.column, { resetGoal: true });
    doc.setSelection(null);
  }

  undo(doc) {
    if (this.desc) buf(doc).undo(this.desc);
    _restore(doc, this.cursorBefore, this.offset);
  }

  redo(doc) { this.execute(doc); }
}

export class ReplaceSelectionCommand {
  constructor(range, replacement, opts = {}) {
    this.type = 'replace';
    this.range = range;
    this.replacement = replacement;
    this.cursorBefore = opts.cursorBefore || null;
    this.deleted = null;
    this.delDesc = null;
    this.insDesc = null;
  }

  execute(doc) {
    const buf = doc.buffer;
    if (this.cursorBefore == null) this.cursorBefore = snapCursor(doc);
    const { start, end } = this.range;
    if (this.deleted == null) this.deleted = buf.getText(start, end - start);
    if (end > start) {
      if (!this.delDesc) this.delDesc = buf.delete(start, end - start);
      else buf.redo(this.delDesc);
    }
    if (this.replacement.length > 0) {
      if (!this.insDesc) this.insDesc = buf.insert(start, this.replacement);
      else buf.redo(this.insDesc);
    }
    const pos = buf.offsetToLineColumn(start + this.replacement.length);
    doc.cursor.setPosition(pos.line, pos.column, { resetGoal: true });
    doc.setSelection(null);
  }

  undo(doc) {
    // Un-apply in the reverse order of execute(): remove the
    // replacement first, then bring back the deleted text.
    if (this.replacement.length > 0 && this.insDesc) buf(doc).undo(this.insDesc);
    if (this.range.end > this.range.start && this.delDesc) buf(doc).undo(this.delDesc);
    _restore(doc, this.cursorBefore, this.range.start);
  }

  redo(doc) { this.execute(doc); }
}

/** Groups several commands as ONE undo step. */
export class CompositeCommand {
  constructor(children = []) {
    this.type = 'composite';
    this.children = children;
    this.label = '';
  }

  get isEmpty() { return this.children.length === 0; }

  add(cmd) { this.children.push(cmd); }

  execute(doc) { for (const c of this.children) c.execute(doc); }
  undo(doc) { for (let i = this.children.length - 1; i >= 0; i--) this.children[i].undo(doc); }
  redo(doc) { for (const c of this.children) c.redo(doc); }

  get last() { return this.children[this.children.length - 1]; }
  get cursorBefore() {
    return this._cursorBefore ?? (this.children.length ? this.children[0].cursorBefore : null);
  }
  set cursorBefore(v) { this._cursorBefore = v; }
  get cursorAfter() {
    return this._cursorAfter ?? (this.children.length ? this.children[this.children.length - 1].cursorAfter : null);
  }
  set cursorAfter(v) { this._cursorAfter = v; }
}

function buf(doc) { return doc.buffer; }

function _restore(doc, cursorBefore, fallbackOffset) {
  if (cursorBefore) {
    doc.cursor.setPosition(cursorBefore.line, cursorBefore.column, { resetGoal: true });
  } else {
    const pos = doc.buffer.offsetToLineColumn(fallbackOffset);
    doc.cursor.setPosition(pos.line, pos.column, { resetGoal: true });
  }
  doc.setSelection(null);
}

export default { InsertTextCommand, DeleteTextCommand, ReplaceSelectionCommand, CompositeCommand };