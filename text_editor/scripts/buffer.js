/* ============================================================
   buffer.js — the heart of the editor.

   DATA STRUCTURE CHOICE: PIECE TABLE
   -----------------------------------
   We use a classic *piece table* for the document text.

   Why a piece table (and why it beats a big string):
   -----------------------------------------------------
   1) A naive implementation stores the doc as one JS string and
      does `str = str.slice(0,p) + ins + str.slice(p)` per keystroke.
      That is O(n) per edit (n = document length) and O(n²) total
      for a session — it visibly janks on documents with thousands
      of lines.
   2) A GAP BUFFER (array + movable gap) is cursor-centric: edits
      at the cursor are O(1), but editing far from the cursor
      requires moving the gap, and rendering/word-wrap still need a
      full scan.
   3) A ROPE (balanced tree of string chunks) is excellent for
      huge files and for sharing structure across undo versions,
      but is considerably more code and only pays off for
      documents well into the tens-of-MBs range.
   4) The PIECE TABLE (used historically by VS Code / Word) keeps
      every edit O(pieces touched) regardless of WHERE it happens
      (start, middle or end of a 10k-line file) and renders by
      walking only visible pieces. Undo/redo can restore the piece
      *list* without copying any text (see commands.js/history.js).

   Layout
   ------
   - original: one immutable string (the file as first loaded).
   - add:      an append-only array of string chunks. Every edit
               appends a new chunk at the end. Chunks are never
               mutated; this makes undo structural, not textual.
   - pieces:   an ordered array of descriptors
               { src: 'ori'|'add', start, len } that tiles the
               logical document. The document is the concatenation
               of pieces in order.

   Operations & complexity (n = doc length, p = #pieces):
   - insert(offset,text): split one piece and splice a new ADD
       piece in                          O(p) worst, O(1) typical
   - delete(offset,len):  trim/split/remove covering pieces  O(p)
   - getText():           concatenate all pieces               O(n)
   - getLine(i):          walk pieces, usually a small slice     O(p)
   - line<->offset:       binary search line-starts            O(log L)

   For a 10k-line doc, p stays in the low tens during a typing
   burst because adjacent ADD pieces referencing the same chunk
   are merged; each keystroke therefore touches a handful of small
   objects instead of copying hundreds of KB of string.

   Note on encoding: all offsets are UTF-16 code units (JS string
   semantics). Grapheme-safe movement for Arabic diacritics / emoji
   is handled by the cursor/input layer via Intl.Segmenter, not in
   the buffer.

   Line index: we keep a sorted array of line-start offsets and
   rebuild it on edit (O(n) one scan, tiny constant). Cached visual
   rows in the renderer make this invisible. A balanced tree would
   scale to 10⁶+ lines; documented tradeoff accepted for simplicity.
   ============================================================ */

const ORI = 'ori';
const ADD = 'add';

class PieceTableBuffer {
  constructor(initialText = '') {
    this._original = initialText;
    this._add = [];                 // append-only chunks
    this._pieces = [];
    if (initialText.length > 0) {
      this._pieces.push({ src: ORI, start: 0, len: initialText.length });
    }
    this._lineStarts = [0];
    this._version = 0;
    this._rebuildLineStarts();
  }

  /* ------------------------------------------------ */
  /* Internal helpers                                 */
  /* ------------------------------------------------ */

  getTotalLength() {
    let n = 0;
    for (const p of this._pieces) n += p.len;
    return n;
  }

  /** Text of a single piece span. */
  _pieceText(piece) {
    if (piece.src === ORI) {
      return this._original.substr(piece.start, piece.len);
    }
    return this._add[piece.chunk].substr(piece.start, piece.len);
  }

  /** Start offset of piece 'index'. */
  _pieceIxStart(index) {
    let acc = 0;
    for (let i = 0; i < index; i++) acc += this._pieces[i].len;
    return acc;
  }

  /** Index of the piece containing 'offset'. */
  _pieceIndexAt(offset) {
    let lo = 0, hi = this._pieces.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offset >= this._pieceIxStart(mid) + this._pieces[mid].len) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _snapshotPieces() {
    return this._pieces.map(p => ({ src: p.src, chunk: p.chunk, start: p.start, len: p.len }));
  }

  _restorePieces(pieces) {
    this._pieces = pieces.map(p => ({ src: p.src, chunk: p.chunk, start: p.start, len: p.len }));
    this._afterEdit();
  }

  /** Merge adjacent pieces that describe contiguous spans within the
      SAME source. ORI pieces are contiguous when start+len of one
      equals the start of the next. ADD pieces may only be merged when
      they reference the same chunk AND the combined span still fits
      inside that chunk (one chunk = one insert's text, so spans that
      tile the same chunk without gaps are safe to join). This keeps
      the piece list small during typing bursts. */
  _mergeAdjacent() {
    const out = [];
    for (const p of this._pieces) {
      const last = out[out.length - 1];
      if (last && last.src === p.src &&
          ((p.src === ORI && last.start + last.len === p.start) ||
           (p.src === ADD && last.chunk === p.chunk && last.start + last.len === p.start))) {
        const chunk = (p.src === ADD) ? this._add[last.chunk] : undefined;
        if (p.src === ORI || (chunk !== undefined && last.start + last.len + p.len <= chunk.length)) {
          last.len += p.len;
          continue;
        }
      }
      out.push({ src: p.src, chunk: p.chunk, start: p.start, len: p.len });
    }
    this._pieces = out;
  }

  /* ------------------------------------------------ */
  /* Edits                                            */
  /* ------------------------------------------------ */

  /**
   * Insert `text` at document offset `offset`.
   * Returns a descriptor {before, after} that undo/redo can replay.
   */
  insert(offset, text) {
    if (!text || text.length === 0) return null;
    const before = this._snapshotPieces();

    // Append text to the add buffer (never mutated again).
    const chunkIdx = this._add.push(text) - 1;

    const total = this.getTotalLength();
    offset = Math.max(0, Math.min(offset, total));

    if (this._pieces.length === 0) {
      this._pieces.push({ src: ADD, chunk: chunkIdx, start: 0, len: text.length });
    } else {
      const idx = this._pieceIndexAt(offset);
      const pieceStart = this._pieceIxStart(idx);

      if (offset === pieceStart) {
        // Insert before piece `idx` (splice insert point).
        const newPiece = { src: ADD, chunk: chunkIdx, start: 0, len: text.length };
        this._pieces.splice(idx, 0, newPiece);
      } else if (idx >= this._pieces.length) {
        // Append at very end of document.
        this._pieces.push({ src: ADD, chunk: chunkIdx, start: 0, len: text.length });
        this._mergeAdjacent();
      } else {
        // Split the containing piece. ADD pieces carry an explicit
        // start INSIDE their chunk, so a split is exact.
        const found = this._pieces[idx];
        const local = offset - pieceStart;
        const head = { src: found.src, chunk: found.chunk, start: found.start, len: local };
        const tail = { src: found.src, chunk: found.chunk, start: found.start + local, len: found.len - local };
        this._pieces.splice(idx, 1, head,
                            { src: ADD, chunk: chunkIdx, start: 0, len: text.length },
                            tail);
      }
    }

    this._afterEdit();
    return { before, after: this._snapshotPieces() };
  }

  /**
   * Delete `length` code units starting at `offset`.
   * Returns a descriptor for undo/redo.
   *
   * Implementation: rebuild the piece list in ONE pass (no in-place
   * splices). Each piece's absolute span is tracked with a running
   * accumulator, so removals never shift the bookkeeping of the
   * pieces we haven't visited yet.
   */
  delete(offset, length) {
    if (length <= 0) return null;
    const before = this._snapshotPieces();
    const total = this.getTotalLength();
    offset = Math.max(0, Math.min(offset, total));
    length = Math.min(length, total - offset);
    const end = offset + length;

    const out = [];
    let acc = 0;
    for (const piece of this._pieces) {
      const ps = acc;              // absolute start of this piece
      const pe = ps + piece.len;   // absolute end of this piece
      if (pe <= offset || ps >= end) {
        out.push(piece);           // untouched by the deletion
        acc = pe;
        continue;
      }
      const keepHead = offset - ps;
      const keepTail = pe - end;
      if (keepHead > 0) out.push({ src: piece.src, chunk: piece.chunk, start: piece.start, len: keepHead });
      if (keepTail > 0) out.push({ src: piece.src, chunk: piece.chunk, start: piece.start + (piece.len - keepTail), len: keepTail });
      acc = pe;
    }

    this._pieces = out;
    this._mergeAdjacent();
    this._afterEdit();
    return { before, after: this._snapshotPieces() };
  }

  /** Revert to the pre-edit state described by a descriptor. */
  undo(desc) {
    if (desc && desc.before) this._restorePieces(desc.before);
  }

  /** Re-apply the edit described by a descriptor. */
  redo(desc) {
    if (desc && desc.after) this._restorePieces(desc.after);
  }

  /* ------------------------------------------------ */
  /* Reads                                            */
  /* ------------------------------------------------ */

  /** Full (or partial) document text. O(n). */
  getText(start = 0, length = null) {
    const total = this.getTotalLength();
    if (length === null) length = total - start;
    length = Math.max(0, Math.min(length, total - start));
    if (length <= 0) return '';

    let out = '';
    let i = start === 0 ? 0 : this._pieceIndexAt(start);
    let pos = start;
    let remaining = length;

    while (remaining > 0 && i < this._pieces.length) {
      const piece = this._pieces[i];
      const ps = this._pieceIxStart(i);
      const local = pos - ps;
      const take = Math.min(piece.len - local, remaining);
      out += this._readChunk(piece, local, take);
      remaining -= take;
      pos += take;
      i++;
    }
    return out;
  }

  _readChunk(piece, start, length) {
    // `start` is the offset INSIDE the piece; combine it with the
    // piece's own start within its source chunk.
    if (piece.src === ORI) return this._original.substr(piece.start + start, length);
    return this._add[piece.chunk].substr(piece.start + start, length);
  }

  getLineCount() { return this._lineStarts.length; }

  /** Text of logical line i, without trailing '\n'. */
  getLine(i) {
    if (i < 0 || i >= this._lineStarts.length) return '';
    const s = this._lineStarts[i];
    const e = (i + 1 < this._lineStarts.length) ? this._lineStarts[i + 1] : this.getTotalLength();
    return this.getText(s, e - s).replace(/\n$/, '');
  }

  /** Length of logical line i, excluding '\n'. */
  getLineLength(i) {
    if (i < 0 || i >= this._lineStarts.length) return 0;
    const s = this._lineStarts[i];
    const e = (i + 1 < this._lineStarts.length) ? this._lineStarts[i + 1] : this.getTotalLength();
    return e - s - (e > s && e - s > 0 && this.getText(e - 1, 1) === '\n' ? 1 : 0);
  }

  /* ------------------------------------------------ */
  /* Line index                                       */
  /* ------------------------------------------------ */

  _rebuildLineStarts() {
    this._lineStarts = [0];
    const text = this.getText();
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this._lineStarts.push(i + 1);
    }
  }

  _afterEdit() {
    this._version++;
    this._rebuildLineStarts();
  }

  /* ------------------------------------------------ */
  /* offset <-> line/column                          */
  /* ------------------------------------------------ */

  offsetToLineColumn(offset) {
    offset = Math.max(0, Math.min(offset, this.getTotalLength()));
    let lo = 0, hi = this._lineStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._lineStarts[mid] > offset) hi = mid;
      else lo = mid + 1;
    }
    const line = lo - 1;
    return { line, column: offset - this._lineStarts[line] };
  }

  lineColumnToOffset(line, column) {
    line = Math.max(0, Math.min(line, this._lineStarts.length - 1));
    const ls = this._lineStarts[line];
    const ll = this.getLineLength(line);
    column = Math.max(0, Math.min(column, ll));
    return ls + column;
  }

  getLineStart(line) {
    if (line < 0) return 0;
    if (line >= this._lineStarts.length) return this.getTotalLength();
    return this._lineStarts[line];
  }

  getLineEnd(line) {
    if (line + 1 < this._lineStarts.length) return this._lineStarts[line + 1];
    return this.getTotalLength();
  }

  getVersion() { return this._version; }

  /** Serialize the *content* (not structure) for persistence. */
  serialize() { return this.getText(); }

  /** Build a fresh buffer from serialized text. */
  static deserialize(text) { return new PieceTableBuffer(text); }
}

export { PieceTableBuffer };
export default PieceTableBuffer;