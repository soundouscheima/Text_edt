/* ============================================================
   selection.js — selection model, stored as *offsets*.
   Offsets (UTF-16 code units) are the single source of truth
   because they survive buffer edits trivially and map cleanly to
   line/column via the buffer. The renderer converts offsets to
   visual rows when drawing highlight rectangles.
   ============================================================ */

export class Selection {
  /** @param {number} anchor offset (fixed point)
      @param {number} head  offset (moving point) */
  constructor(anchor, head = anchor) {
    this.anchor = anchor;
    this.head = head;
    this.active = true;
  }

  get isEmpty() { return this.anchor === this.head; }

  /** start/end — normalized order for range ops. */
  get start() { return Math.min(this.anchor, this.head); }
  get end() { return Math.max(this.anchor, this.head); }

  /** Extend the head to a new offset; anchor stays put. */
  extend(offset, opts = {}) {
    if (!this.active && !opts.force) return;
    this.head = offset;
    this.active = true;
  }

  collapse() { this.head = this.anchor; }

  setAll(anchor, head = anchor) {
    this.anchor = anchor;
    this.head = head;
    this.active = true;
  }

  isForward() { return this.head >= this.anchor; }

  clone() {
    const s = new Selection(this.anchor, this.head);
    s.active = this.active;
    return s;
  }

  isEmptyFor(buffer) { return this.isEmpty; }

  serialize() { return { anchor: this.anchor, head: this.head }; }

  static deserialize(o) {
    return new Selection(o.anchor, o.head);
  }
}

export default Selection;