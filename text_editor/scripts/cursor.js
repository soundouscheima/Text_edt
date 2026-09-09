/* ============================================================
   cursor.js — cursor position model.

   The cursor is a *logical* {line, column} position (0-based),
   backed by the buffer's line index. It is NOT a DOM caret — the
   renderer draws a custom blinking div. The "goal column" sticky
   behavior for Up/Down navigation lives here.

   GOAL-COLUMN ("sticky column") BEHAVIOR
   ---------------------------------------
   Most naive editors treat Up/Down as "move to the same character
   column on the adjacent line". That breaks when lines have
   varying lengths: going down from column 20 on a 50-char line to
   a 5-char line lands on column 5, then going further down to a
   40-char line must SNAP BACK toward column 20. If you only store
   the *current* column, by the time you've passed the short line
   your "column" is 5 and you'll drift left forever.

   Fix: keep a separate `goalColumn` that is:
     - set fresh whenever the user moves *horizontally* (Left/Right,
       click, Home/End, typing, word-jump) — this resets the anchor,
     - PRESERVED across consecutive vertical moves. Each vertical
       move clamps the actual caret to min(goalColumn, lineLength),
       and if the line is long again the caret "snaps back" to the
       original goalColumn.

   We ALSO track goalX in pixels. For variable-width fonts the
   purely character-based goal is often wrong (10 'i' chars ≠ 10
   'م' chars), so when Word Wrap / rendering is aware we prefer the
   pixel-based goal. We store both: `goalColumn` (chars) and
   `goalX` (CSS pixels, set by renderer-aware code). If goalX is
   set we use it to pick the nearest character on the target row;
   otherwise we fall back to character columns.

   Manual test case (see README):
     1. Type 40 chars on line 1, 3 chars on line 2, 40 on line 3.
     2. Put cursor near column 25 on line 1.
     3. Press Down → caret on line 2 col 3.  Press Down → caret on
        line 3 ≈ col 25 (snaps BACK, not stuck at 3).
   ============================================================ */

import { clamp } from './util.js';

export class Cursor {
  constructor(line = 0, column = 0) {
    this.line = line;
    this.column = column;
    this.goalColumn = column;   // sticky column (characters)
    this.goalX = null;          // sticky column (pixels), when known
    this.affinity = 'down';     // caret affinity for wrapped rows
  }

  clone() {
    const c = new Cursor(this.line, this.column);
    c.goalColumn = this.goalColumn;
    c.goalX = this.goalX;
    c.affinity = this.affinity;
    return c;
  }

  /** Set an absolute position; horizontal moves reset the goal. */
  setPosition(line, column, opts = {}) {
    this.line = line;
    this.column = column;
    this.affinity = opts.affinity || 'down';
    if (opts.resetGoal) {
      this.goalColumn = column;
      this.goalX = null;
    }
  }

  equals(other) {
    return !!other && other.line === this.line && other.column === this.column;
  }

  /** True if `p` is strictly before this position. */
  isBefore(other) {
    return other.line > this.line ||
           (other.line === this.line && other.column > this.column);
  }

  serialize() { return { line: this.line, column: this.column }; }

  static deserialize(o) {
    return new Cursor(o.line || 0, o.column || 0);
  }

  /** Clamp a position onto a line length. */
  static clampCol(lineLen, col) { return clamp(col, 0, lineLen); }
}

export default Cursor;