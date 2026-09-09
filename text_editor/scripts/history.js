/* ============================================================
   history.js — Undo/Redo manager built on the Command pattern.

   WHY COMMAND PATTERN OVER MEMENTO
   --------------------------------
   A Memento design would snapshot the entire document state after
   every edit. For a 1 MB document that's ~1 MB per history entry,
   so 500 entries ≈ 500 MB of sealed strings the GC must copy.
   Instead every history entry is a COMMAND object holding the
   *diff* of the edit (an insert stores {offset, text, piece-state
   before/after}). Undoing replays the reverse piece-state in O(p)
   with zero text copying (see buffer.js). This is the pattern used
   by real editors and keeps memory bounded by edit count, not doc
   size.

   STACKS
   ------
   undoStack: commands that have been APPLIED, oldest→newest.
   redoStack: commands that have been UN-APPLIED (cancelled).
   - push(cmd)           applies a command (or appends to the open
                         typing group) and clears the redo stack.
   - undo()              pops undoStack, un-applies, pushes redoStack,
                         restores pre-command cursor.
   - redo()              pops redoStack, re-applies, pushes undoStack,
                         restores post-command cursor.

   GROUPED TYPING
   --------------
   Typing "hello" must feel like ONE undo step. input.js opens a
   group via beginGroup(), applies each keystroke immediately for
   responsive rendering, and records the command into the working
   CompositeCommand. endGroup() seals the composite into the undo
   stack. An explicit action (backspace, paste, AI insert, cursor
   move) commits the open group first.

   CAP: to bound memory we keep no more than HISTORY_LIMIT entries,
   trimming the oldest. (The piece table keeps each entry tiny, but
   a pathological paste-heavy session could still grow.)

   Persisting undo history across reload:
   --------------------------------------
   Deliberately NOT implemented. Command offsets are absolute and
   would silently corrupt the document if the restored text differs
   from the text the commands were recorded against. Doing it
   safely requires versioned snapshots (linking each command to the
   exact serialized buffer state) which multiplies storage cost
   for almost no real benefit — real-world undo rarely needs to
   survive a browser restart. We DO persist document content,
   cursor, scroll and tabs (see persistence.js) which is the
   reliable 98% case.
   ============================================================ */

import { CompositeCommand } from './commands.js';

export class HistoryManager {
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.limit = opts.limit || 1000;
    this.undoStack = [];
    this.redoStack = [];
    this.openGroup = null;
    this._cursorBeforeGroup = null;
    this.onChange = opts.onChange || (() => {});
  }

  /** Open (or reuse) a typing group. */
  beginGroup(label = '') {
    if (!this.openGroup) {
      this.openGroup = new CompositeCommand();
      this.openGroup.label = label;
      this._cursorBeforeGroup = this._snapshotCursor();
    } else if (label && !this.openGroup.label) {
      this.openGroup.label = label;
    }
    return this.openGroup;
  }

  get isGroupOpen() { return !!this.openGroup; }

  /** Commit the open group into the undo stack (no-op if empty). */
  endGroup() {
    if (!this.openGroup) return false;
    const group = this.openGroup;
    this.openGroup = null;
    const before = this._cursorBeforeGroup;
    this._cursorBeforeGroup = null;
    if (group.isEmpty) return false;
    group.cursorBefore = before || this._snapshotCursor();
    group.cursorAfter = this._snapshotCursor();
    // Seal: the group's children have already been applied live.
    this.undoStack.push(group);
    this.redoStack.length = 0;
    this._trim();
    this.onChange();
    return true;
  }

  /** Add a command: if a group is open, add it (do NOT execute —
      the group as a whole was applied live); otherwise execute and
      record. */
  add(cmd) {
    if (cmd.type === 'noop' || cmd.isEmpty) return;
    if (this.openGroup) {
      this.openGroup.add(cmd);
      return cmd;
    }
    cmd.execute(this.doc);
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this._trim();
    this.onChange();
    return cmd;
  }

  /** Undo one step (or a whole group). Returns true if applied. */
  undo() {
    this.endGroup();
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo(this.doc);
    this.redoStack.push(cmd);
    this._restoreCursor(cmd.cursorBefore);
    this.onChange();
    return true;
  }

  /** Redo one step. Returns true if applied. */
  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.redo(this.doc);
    this.undoStack.push(cmd);
    this._restoreCursor(cmd.cursorAfter);
    this.onChange();
    return true;
  }

  canUndo() { return this.undoStack.length > 0 || (this.openGroup && !this.openGroup.isEmpty); }
  canRedo() { return this.redoStack.length > 0; }

  _snapshotCursor() {
    const c = this.doc.cursor;
    return { line: c.line, column: c.column };
  }

  _restoreCursor(pos) {
    if (!pos) { this.doc.setSelection(null); return; }
    this.doc.cursor.setPosition(pos.line, pos.column, { resetGoal: true });
    this.doc.setSelection(null);
  }

  _trim() {
    while (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  clear() {
    this.endGroup();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange();
  }

  serializeSummary() { return { undo: this.undoStack.length, redo: this.redoStack.length }; }
}

export default HistoryManager;