/* ============================================================
   renderer.js — turns buffer + cursor + selection into DOM.

   TWO COORDINATE SYSTEMS (the crux)
   ----------------------------------
   LOGICAL model: the buffer's real lines, split only on '\n'.
   Cursor/edit operations live here.
   VISUAL model: computed at render time. A long logical line is
   broken into VISUAL ROWS based on the measured pixel width of
   the container and the actual (variable-width) glyph widths.

   Because a row's row-count depends ONLY on its own line's text
   and the wrap width (never on neighbors), we can maintain exact
   global geometry cheaply:
     rowCounts[line] → number of visual rows for that logical line
     prefix[line]    → count of rows before that line
   Every edit only invalidates the edited line's count; the prefix
   sum is rebuilt in one O(lines) pass (tiny constant, invisible at
   even 50k lines) OR updated on cache hits.

   ROW COORDINATE CONVENTION
   -------------------------
   All row-internal X values are measured from the LEFT edge of the
   row's visible text box in DISPLAY space, regardless of direction.
   - LTR: caret before col k sits at x = Σ width(glyphs<k).
   - RTL: glyphs flow right→left, so caret before col k sits at
          x = rowWidth − Σ width(glyphs<k), i.e. the boundary
          positions are [rowWidth, rowWidth−w0, …]. This is exactly
          the mirror of LTR and gives correct caret/click mapping
          for pure-Arabic and Arabic+numbers rows.
   The row's text box itself is right-aligned in wrap mode (text
   hugs the right edge), so we offset by (wrapWidth − rowWidth)
   when the row is RTL and wrapped.

   BIDI MIXED LINES: rendering is perfect (the browser shapes and
   orders runs). Cursor/hit-test math uses the linear advance model
   above; for truly interleaved-script lines this is an
   approximation (documented tradeoff).

   WORD WRAP
   ---------
   - Never splits a grapheme (Intl.Segmenter).
   - Breaks at the last whitespace that fit; hard-breaks mid-word
     only if a single word exceeds the row width (covers Arabic).
   - A whitespace used as a break point is elided from display but
     stays in the logical text.

   VIRTUALIZATION
   --------------
   Only rows intersecting the viewport (± slack) are materialized
   as pooled absolutely-positioned divs. Y positions are in
   document space; viewport scrolling moves them naturally, so
   scrolling never reparses text.
   ============================================================ */

import {
  nextGrapheme, detectLineDirection, clamp,
} from './util.js';

const PAD = 8;
const VSLACK = 2;

export class Renderer {
  constructor(els) {
    this.viewport = els.viewport;
    this.linesEl = els.lines;
    this.gutterEl = els.gutter;
    this.selectionLayer = els.selectionLayer;
    this.caretEl = els.caretEl;

    this.buffer = null;
    this.opts = {
      fontSize: 16,
      fontFamily: "Consolas, 'Courier New', monospace",
      wrap: true,
      lineHeight: 1.5,
      showLineNumbers: true,
      docDir: 'ltr',
    };

    this._measure = document.createElement('canvas').getContext('2d');

    this.rowCache = new Map();     // lineIndex → VisualRow[]
    this._mx = 400;
    this.rowCounts = [];
    this.prefix = [0];

    this.matches = [];
    this.activeMatch = 0;

    this.rowHeight = 20;
    this.wrapWidth = 0;
    this.maxLineWidth = 0;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.viewportW = 0;
    this.viewportH = 0;
    this.domPool = [];
    this.selPool = [];
    this.matchPool = [];
    this.curLineBgs = [];
    this.gutterPool = [];

    this._visibleCache = [];
    this._sel = null;
    this._lastCursor = null;
    this._savedCaretVisible = false;

    this._bindResizeObserver();
  }

  /* ------------------------------------------------ */
  /* Setup                                            */
  /* ------------------------------------------------ */

  setBuffer(buffer) {
    this.buffer = buffer;
    this.rowCache.clear();
    this._rebuildRowCounts();
    this.matches = [];
    this.render();
  }

  setOptions(patch) {
    Object.assign(this.opts, patch);
    this._applyFont();
    this.rowCache.clear();
    this._rebuildRowCounts();
    this.render();
  }

  _applyFont() {
    const q = `"${this.opts.fontFamily}"`;
    this.linesEl.style.fontFamily = q;
    this.linesEl.style.fontSize = this.opts.fontSize + 'px';
    this.linesEl.style.lineHeight = String(this.opts.lineHeight);
    this._measure.font = `${this.opts.fontSize}px ${q}`;
    this._measure.fontKerning = 'normal';
    // real rendered line height
    const probe = document.createElement('div');
    probe.className = 'vline';
    probe.textContent = 'Hgم';
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.style.whiteSpace = 'pre';
    probe.style.fontFamily = q;
    probe.style.fontSize = this.opts.fontSize + 'px';
    probe.style.lineHeight = String(this.opts.lineHeight);
    document.body.appendChild(probe);
    const lh = probe.getBoundingClientRect().height;
    probe.remove();
    this.rowHeight = lh > 0 ? lh : this.opts.fontSize * this.opts.lineHeight;
  }

  _bindResizeObserver() {
    const ro = new ResizeObserver(() => {
      const w = this.viewport.clientWidth;
      const h = this.viewport.clientHeight;
      if (w === this.viewportW && h === this.viewportH) return;
      this.viewportW = w;
      this.viewportH = h;
      this.wrapWidth = Math.max(50, w - PAD * 2);
      this.rowCache.clear();
      this._rebuildRowCounts();
      this.render();
    });
    ro.observe(this.viewport);
    this.viewport.addEventListener('scroll', () => {
      const st = this.viewport.scrollTop;
      const sl = this.viewport.scrollLeft;
      if (st === this.scrollTop && sl === this.scrollLeft) return;
      this.scrollTop = st;
      this.scrollLeft = sl;
      this._paint();
    }, { passive: true });
  }

  /* ------------------------------------------------ */
  /* Geometry bookkeeping                             */
  /* ------------------------------------------------ */

  _rebuildRowCounts() {
    if (!this.buffer) return;
    const L = this.buffer.getLineCount();
    this.rowCounts = new Array(L);
    this.prefix = new Array(L + 1);
    let acc = 0;
    for (let i = 0; i < L; i++) {
      const cached = this.rowCache.get(i);
      const n = cached ? cached.length : 1;
      this.rowCounts[i] = n;
      this.prefix[i] = acc;
      acc += n;
    }
    this.prefix[L] = acc;
    this._updateDocHeight();
  }

  _rebuildPrefix() {
    if (!this.buffer) return;
    const L = this.buffer.getLineCount();
    if (this.rowCounts.length !== L) this.rowCounts = this.rowCounts.slice(0, L);
    this.prefix = new Array(L + 1);
    let acc = 0;
    for (let i = 0; i < L; i++) {
      this.prefix[i] = acc;
      acc += this.rowCounts[i] || 1;
    }
    this.prefix[L] = acc;
    this._updateDocHeight();
  }

  _updateDocHeight() {
    if (!this.buffer) return;
    const total = this.prefix[this.prefix.length - 1] || 0;
    const H = (total * this.rowHeight) + 'px';
    this.linesEl.style.height = H;
    this.selectionLayer.style.height = H;
    const contentW = this.opts.wrap
      ? Math.max(this.wrapWidth + PAD * 2, this.viewportW || 100)
      : Math.max(this.maxLineWidth + PAD * 2, this.viewportW || 100);
    this.linesEl.style.width = contentW + 'px';
  }

  invalidateFromLine(lineIdx) {
    if (!this.buffer) return;
    const L = this.buffer.getLineCount();
    this.rowCache.delete(lineIdx);
    if (this.rowCounts.length !== L) {
      for (let i = lineIdx; i <= L; i++) this.rowCache.delete(i);
      this._rebuildRowCounts();
    } else {
      const cached = this.rowCache.get(lineIdx);
      this.rowCounts[lineIdx] = cached ? cached.length : 1;
      this._rebuildPrefix();
    }
  }

  /* ------------------------------------------------ */
  /* Measurement & layout                             */
  /* ------------------------------------------------ */

  _measureWidth(text) {
    return text === '\t' ? this._measure.measureText('    ').width : this._measure.measureText(text).width;
  }

  /** Grapheme widths for a line/row string. */
  _lineChars(text) {
    const chars = [];
    if (!text) return chars;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const e = nextGrapheme(text, i);
      const seg = text.slice(i, e);
      chars.push({ s: i, e, w: this._measureWidth(seg) });
      i = e;
    }
    return chars;
  }

  /** Build visual rows for one logical line. */
  _layoutLine(lineIdx) {
    const text = this.buffer.getLine(lineIdx);
    const chars = this._lineChars(text);
    const maxW = this.opts.wrap ? this.wrapWidth : Infinity;
    const rows = [];

    if (chars.length === 0) {
      rows.push(this._mkRow(lineIdx, 0, 0, '', false, 0));
      return rows;
    }

    let start = 0;          // char-index where the current row starts
    let w = 0;              // accumulated width from `start`
    let lastSpace = null;   // {idx, wBefore}
    const splitRow = (endCharIdx, usedW, nextStart) => {
      const startCol = chars[start].s;
      const endCol = endCharIdx > 0 ? chars[endCharIdx - 1].e : startCol;
      const nextCol = nextStart < chars.length ? chars[nextStart].s : text.length;
      const rowText = (nextCol > endCol) ? text.slice(startCol, endCol) : text.slice(startCol, endCol);
      rows.push(this._mkRow(lineIdx, startCol, endCol, rowText, start > 0, usedW));
    };

    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const isSpace = c.e <= c.s ? false : /\s/u.test(text.slice(c.s, c.e));
      if (w + c.w > maxW && w > 0) {
        if (lastSpace && lastSpace.idx >= start) {
          // break after the last whitespace that fit
          const breakIdx = lastSpace.idx;
          splitRow(breakIdx, lastSpace.wBefore, breakIdx + 1);
          start = breakIdx + 1;
          w = 0;
          lastSpace = null;
          i = start - 1; // re-scan from new start (chars were not all consumed)
          continue;
        }
        // hard break (single word wider than the row)
        splitRow(i, w, i);
        start = i;
        w = 0;
        lastSpace = null;
        i = start - 1;
        continue;
      }
      w += c.w;
      if (isSpace) { lastSpace = { idx: i, wBefore: w - c.w }; }
    }

    if (start < chars.length) {
      splitRow(chars.length, w, chars.length);
    } else if (rows.length === 0) {
      rows.push(this._mkRow(lineIdx, text.length, text.length, '', true, 0));
    }
    return rows;
  }

  _mkRow(line, startCol, endCol, text, isContinuation, width) {
    const dir = detectLineDirection(text) === 'rtl' ? 'rtl' : 'ltr';
    return {
      line, startCol, endCol, text,
      isContinuation, width,
      dir, localRow: null, chars: null,
    };
  }

  /* ------------------------------------------------ */
  /* Row lookup                                       */
  /* ------------------------------------------------ */

  _rowsForLine(lineIdx) {
    if (!this.buffer || lineIdx < 0 || lineIdx >= this.buffer.getLineCount()) return [];
    let rows = this.rowCache.get(lineIdx);
    if (!rows) {
      rows = this._layoutLine(lineIdx);
      for (const r of rows) r.chars = this._lineChars(r.text);
      this.rowCache.set(lineIdx, rows);
      if (this.rowCache.size > this._mx) {
        const keys = [...this.rowCache.keys()].slice(0, this._mx >> 1);
        for (const k of keys) this.rowCache.delete(k);
      }
      if (this.rowCounts[lineIdx] !== rows.length) {
        this.rowCounts[lineIdx] = rows.length;
        this._rebuildPrefix();
      }
      if (!this.opts.wrap) {
        let rw = 0;
        for (const r of rows) rw = Math.max(rw, r.width);
        if (rw > this.maxLineWidth) { this.maxLineWidth = rw; this._updateDocHeight(); }
      }
    }
    return rows;
  }

  _globalRowOfRow(row) {
    let local = row.localRow;
    if (local == null) {
      const rows = this._rowsForLine(row.line);
      local = rows.indexOf(row);
      row.localRow = local;
    }
    return this.prefix[row.line] + local;
  }

  _locateRow(globalRow) {
    if (!this.buffer) return { line: null, local: 0 };
    const P = this.prefix;
    let lo = 0, hi = P.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (P[mid] <= globalRow) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, local: globalRow - P[lo] };
  }

  /** The visual row structure containing a buffer offset. */
  visualRowOfOffset(offset) {
    if (!this.buffer) return null;
    const { line, column } = this.buffer.offsetToLineColumn(offset);
    const rows = this._rowsForLine(line);
    let row = null;
    for (const r of rows) {
      if (column >= r.startCol && column <= r.endCol) { row = r; break; }
      if (column < r.startCol) { row = r; break; }
    }
    if (!row && rows.length) row = rows[rows.length - 1];
    if (!row) return { line, localRow: 0, row: null };
    const localRow = rows.indexOf(row);
    row.localRow = localRow;
    return { line, localRow, globalRow: this.prefix[line] + localRow, row };
  }

  /* ------------------------------------------------ */
  /* Row-local X math (display space, from left)       */
  /* ------------------------------------------------ */

  _rowWidth(row) {
    if (row.chars) {
      let w = 0;
      for (const c of row.chars) w += c.w;
      return w;
    }
    return row.width;
  }

  /** Sum of glyph widths strictly to the left of logical `col`
      within this row (display-space, direction-agnostic). */
  _advanceWidth(row, col) {
    let w = 0;
    for (const c of row.chars) {
      if (col <= c.s) break;
      w += c.w; // partial grapheme still counts its full advance
    }
    return w;
  }

  /** doc-space X (px from the container's left, ignoring scroll)
      of the caret boundary at logical column `col` in `row`. */
  docXOfColumn(row, col) {
    col = clamp(col, row.startCol, row.endCol);
    const rw = this._rowWidth(row);
    const fromLeft = row.dir === 'rtl' ? rw - this._advanceWidth(row, col) : this._advanceWidth(row, col);
    const textLeft = (this.opts.wrap && row.dir === 'rtl') ? this.wrapWidth - rw : 0;
    return textLeft + fromLeft;
  }

  /** Nearest logical column to an X within the row's text box.
      Threatens by nearest boundary position. */
  colAtX(row, xInText) {
    const chars = row.chars;
    const rw = this._rowWidth(row);
    const bounds = [];
    if (row.dir === 'rtl') {
      let b = rw;
      bounds.push(b);
      for (const c of chars) { b -= c.w; bounds.push(b); }
    } else {
      let b = 0;
      bounds.push(b);
      for (const c of chars) { b += c.w; bounds.push(b); }
    }
    // nearest boundary (glyph-box edges are the caret positions)
    let best = 0, bestD = Infinity;
    for (let k = 0; k < bounds.length; k++) {
      const d = Math.abs(xInText - bounds[k]);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best >= chars.length) return row.endCol;
    return row.startCol + chars[best].s; // boundary k sits before char k
  }

  /* ------------------------------------------------ */
  /* Rendering                                        */
  /* ------------------------------------------------ */

  render() {
    if (!this.buffer) return;
    this._paint();
  }

  _paint() {
    if (!this.buffer) return;
    const total = this.prefix[this.prefix.length - 1] || 0;
    const first = Math.max(0, Math.floor(this.scrollTop / Math.max(1, this.rowHeight)) - VSLACK);
    const last = Math.min(total, Math.ceil((this.scrollTop + this.viewportH) / Math.max(1, this.rowHeight)) + VSLACK);

    const visible = [];
    for (let g = first; g < last; g++) {
      const { line, local } = this._locateRow(g);
      if (line == null) continue;
      const rows = this._rowsForLine(line);
      const r = rows[local];
      if (!r) continue;
      r.localRow = local;
      visible.push(r);
    }
    this._visibleCache = visible;

    this._paintText(visible);
    this._paintGutter(visible);
    this._paintCurrentLine();
    this._paintSelection();
    this._paintMatches();
    this._paintCaret();
  }

  _paintText(visible) {
    const wrap = this.opts.wrap;
    while (this.domPool.length < visible.length) {
      const el = document.createElement('div');
      el.className = 'vline';
      this.linesEl.appendChild(el);
      this.domPool.push({ el, used: false });
    }
    for (const p of this.domPool) p.used = false;

    for (let k = 0; k < visible.length; k++) {
      const row = visible[k];
      const p = this.domPool[k];
      p.used = true;
      const el = p.el;
      const y = this._globalRowOfRow(row) * this.rowHeight;
      el.style.top = y + 'px';
      el.style.height = this.rowHeight + 'px';
      el.style.lineHeight = this.rowHeight + 'px';
      el.style.direction = row.dir;
      el.style.textAlign = row.dir === 'rtl' ? 'right' : 'left';
      if (wrap) {
        el.style.left = '0';
        el.style.right = '0';
        el.style.width = 'auto';
        el.style.display = '';
      } else {
        el.style.right = 'auto';
        el.style.width = this._rowWidth(row) + 'px';
        el.style.display = '';
      }
      if (el.textContent !== row.text) el.textContent = row.text;
      el.style.visibility = 'visible';
    }
    for (let k = visible.length; k < this.domPool.length; k++) {
      this.domPool[k].used = false;
      this.domPool[k].el.style.visibility = 'hidden';
    }
  }

  _paintCurrentLine() {
    for (const el of this.curLineBgs) el.remove();
    this.curLineBgs = [];
    if (!this._lastCursor || !this.buffer) return;
    const rows = this._rowsForLine(this._lastCursor.line);
    if (!rows) return;
    for (const r of rows) {
      const el = document.createElement('div');
      el.className = 'current-line-bg';
      el.style.top = (this._globalRowOfRow(r) * this.rowHeight) + 'px';
      el.style.height = this.rowHeight + 'px';
      this.linesEl.appendChild(el);
      this.curLineBgs.push(el);
    }
  }

  _paintGutter(visible) {
    if (!this.opts.showLineNumbers) { this.gutterEl.style.display = 'none'; return; }
    this.gutterEl.style.display = '';
    this.gutterEl.style.transform = `translateY(${-this.scrollTop}px)`;
    let used = 0;
    const drawn = new Set();
    for (const row of visible) {
      if (drawn.has(row.line)) continue;
      drawn.add(row.line);
      let le = this.gutterPool[used];
      if (!le) {
        le = document.createElement('div');
        le.className = 'gutter-num';
        this.gutterEl.appendChild(le);
        this.gutterPool.push(le);
      }
      const y = this._globalRowOfRow(row) * this.rowHeight;
      le.style.top = y + 'px';
      le.style.height = this.rowHeight + 'px';
      le.style.lineHeight = this.rowHeight + 'px';
      le.textContent = String(row.line + 1);
      le.classList.toggle('current', !!(this._lastCursor && this._lastCursor.line === row.line));
      le.style.display = '';
      used++;
    }
    for (let i = used; i < this.gutterPool.length; i++) this.gutterPool[i].style.display = 'none';
  }

  /* ------------------------------------------------ */
  /* Selection                                        */
  /* ------------------------------------------------ */

  setSelection(sel) {
    this._sel = sel;
    this._paintSelection();
  }

  _paintSelection() {
    for (const el of this.selPool) el.remove();
    this.selPool = [];
    if (!this._sel || !this.buffer || this._sel.isEmpty) return;
    const startOff = this._sel.start;
    const endOff = this._sel.end;
    const { line: startLine, column: startCol } = this.buffer.offsetToLineColumn(startOff);
    const { line: endLine, column: endCol } = this.buffer.offsetToLineColumn(endOff);

    for (let line = startLine; line <= endLine; line++) {
      if (line >= this.buffer.getLineCount()) break;
      const rows = this._rowsForLine(line);
      const lineLen = this.buffer.getLineLength(line);
      const segStart = line === startLine ? startCol : 0;
      const segEnd = line === endLine ? Math.min(endCol, lineLen) : lineLen;
      for (const row of rows) {
        const a = Math.max(row.startCol, segStart);
        const b = Math.min(row.endCol, segEnd);
        if (a >= b) {
          // interior full row
          if (segStart <= row.startCol && segEnd >= row.endCol) this._addSelRect(row, row.startCol, row.endCol);
          continue;
        }
        this._addSelRect(row, a, b);
      }
    }
  }

  _addSelRect(row, a, b) {
    const x1 = this.docXOfColumn(row, a);
    const x2 = this.docXOfColumn(row, b);
    const y = this._globalRowOfRow(row) * this.rowHeight;
    if (y + this.rowHeight < this.scrollTop || y > this.scrollTop + this.viewportH) return;
    const el = document.createElement('div');
    el.className = 'sel-rect';
    el.style.top = y + 'px';
    el.style.height = this.rowHeight + 'px';
    el.style.left = Math.min(x1, x2) + 'px';
    el.style.width = Math.max(1, Math.abs(x2 - x1)) + 'px';
    this.selectionLayer.appendChild(el);
    this.selPool.push(el);
  }

  /* ------------------------------------------------ */
  /* Find matches                                     */
  /* ------------------------------------------------ */

  setMatches(matches, activeMatch) {
    this.matches = matches || [];
    this.activeMatch = activeMatch || 0;
    this._paintMatches();
  }

  _paintMatches() {
    for (const el of this.matchPool) el.remove();
    this.matchPool = [];
    if (!this.matches.length || !this.buffer) return;
    for (let mi = 0; mi < this.matches.length; mi++) {
      const m = this.matches[mi];
      const { line, column } = this.buffer.offsetToLineColumn(m.start);
      const endLc = this.buffer.offsetToLineColumn(Math.max(m.end - 1, m.start));
      if (endLc.line !== line) {
        // multi-line match: highlight the part on this line
        const rows = this._rowsForLine(line);
        if (!rows) continue;
        const lineLen = this.buffer.getLineLength(line);
        for (const row of rows) {
          const a = Math.max(row.startCol, column);
          if (a < lineLen) this._addMatchRect(row, a, Math.min(row.endCol, lineLen), mi);
        }
        continue;
      }
      const rows = this._rowsForLine(line);
      if (!rows) continue;
      for (const row of rows) {
        const a = Math.max(row.startCol, column);
        const b = Math.min(row.endCol, endLc.column);
        if (a < b) this._addMatchRect(row, a, b, mi);
      }
    }
  }

  _addMatchRect(row, a, b, mi) {
    // Only paint rects fully inside the row; clipped parts painted
    // on their owning row by caller.
    const x1 = this.docXOfColumn(row, a);
    const x2 = this.docXOfColumn(row, b);
    const y = this._globalRowOfRow(row) * this.rowHeight;
    if (y + this.rowHeight < this.scrollTop || y > this.scrollTop + this.viewportH) return;
    const el = document.createElement('div');
    el.className = 'find-match';
    if (mi === this.activeMatch) el.classList.add('active');
    el.style.top = y + 'px';
    el.style.height = this.rowHeight + 'px';
    el.style.left = Math.min(x1, x2) + 'px';
    el.style.width = Math.max(1, Math.abs(x2 - x1)) + 'px';
    this.selectionLayer.appendChild(el);
    this.matchPool.push(el);
  }

  /* ------------------------------------------------ */
  /* Caret                                            */
  /* ------------------------------------------------ */

  moveCursorTo(cursor) {
    this._lastCursor = { line: cursor.line, column: cursor.column };
    this._paintCaret();
  }

  _paintCaret() {
    if (!this._lastCursor || !this.buffer) return;
    const offset = this.buffer.lineColumnToOffset(this._lastCursor.line, this._lastCursor.column);
    const v = this.visualRowOfOffset(offset);
    if (!v || !v.row) return;
    const row = v.row;
    const col = clamp(this._lastCursor.column, row.startCol, row.endCol);
    const x = this.docXOfColumn(row, col);
    const y = this._globalRowOfRow(row) * this.rowHeight;

    this.caretEl.style.top = y + 'px';
    this.caretEl.style.height = this.rowHeight + 'px';
    this.caretEl.style.transform = `translateX(${x}px)`;
    this.caretEl.style.visibility = 'visible';
    this._savedCaretVisible = true;

    // reset blink on movement
    this.caretEl.classList.remove('blink-active');
    void this.caretEl.offsetWidth;
    this.caretEl.classList.add('blink-active');

    const pos = this.positionInputProxy(x, y);
    if (pos) this.caretEl._proxyPos = pos;

    this._ensureVisible(row, x);
  }

  _ensureVisible(row, caretX) {
    const y = this._globalRowOfRow(row) * this.rowHeight;
    const rw = this._rowWidth(row);
    const textLeft = (this.opts.wrap && row.dir === 'rtl') ? this.wrapWidth - rw : 0;
    let st = this.viewport.scrollTop;
    let sl = this.viewport.scrollLeft;
    const pad = 40;
    if (y < st + pad) st = Math.max(0, y - pad);
    else if (y + this.rowHeight > st + this.viewportH - pad) st = Math.max(0, y + this.rowHeight - (this.viewportH - pad));
    if (caretX < sl + pad) sl = Math.max(0, caretX - pad);
    else if (caretX + 8 > sl + this.viewportW - pad) sl = Math.max(0, caretX + 8 - (this.viewportW - pad));
    if (st !== this.scrollTop) this.viewport.scrollTop = st;
    if (sl !== this.scrollLeft) this.viewport.scrollLeft = sl;
    void textLeft;
  }

  positionInputProxy(x, y) {
    const p = document.getElementById('input-proxy');
    if (!p) return null;
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    return p;
  }

  /* ------------------------------------------------ */
  /* Hit testing                                      */
  /* ------------------------------------------------ */

  pxToOffset(clientX, clientY) {
    if (!this.buffer) return null;
    const rect = this.viewport.getBoundingClientRect();
    let docX = clientX - rect.left + this.scrollLeft;
    const docY = clientY - rect.top + this.scrollTop;
    if (docX < 0) docX = 0;
    const total = this.prefix[this.prefix.length - 1] || 0;
    let globalRow = Math.floor(docY / Math.max(1, this.rowHeight));
    if (globalRow >= total) {
      return this.buffer.getTotalLength();
    }
    const { line, local } = this._locateRow(globalRow);
    const rows = this._rowsForLine(line);
    const row = rows[local] || rows[rows.length - 1];
    if (!row) return this.buffer.lineColumnToOffset(line, 0);

    const rw = this._rowWidth(row);
    const textLeft = (this.opts.wrap && row.dir === 'rtl') ? this.wrapWidth - rw : 0;
    let xInText = docX - textLeft;
    if (xInText < 0) xInText = 0;
    if (xInText > rw) xInText = rw;
    let col = this.colAtX(row, xInText);
    col = clamp(col, row.startCol, row.endCol);
    return this.buffer.lineColumnToOffset(row.line, col);
  }

  offsetToPx(offset) {
    if (!this.buffer) return { x: 0, y: 0, h: this.rowHeight };
    const v = this.visualRowOfOffset(offset);
    if (!v || !v.row) {
      const { line } = this.buffer.offsetToLineColumn(offset);
      const rows = this._rowsForLine(line);
      const row = rows[rows.length - 1];
      if (!row) return { x: 0, y: this.buffer.lineColumnToOffset(line, 0) ? 0 : 0, h: this.rowHeight };
      const localRow = rows.length - 1;
      row.localRow = localRow;
      const x = this.docXOfColumn(row, offset ? this.buffer.offsetToLineColumn(offset).column : 0);
      const y = (this.prefix[line] + localRow) * this.rowHeight;
      return { x, y, h: this.rowHeight };
    }
    const row = v.row;
    const { column } = this.buffer.offsetToLineColumn(offset);
    const col = clamp(column, row.startCol, row.endCol);
    const x = this.docXOfColumn(row, col);
    const y = this._globalRowOfRow(row) * this.rowHeight;
    return { x, y, h: this.rowHeight };
  }

  /* ------------------------------------------------ */
  /* Visual navigation                                */
  /* ------------------------------------------------ */

  /** Move to the adjacent VISUAL row (dir ±1), keeping caret at the
      same doc-space X. Returns new offset. */
  moveVertically(offset, dir) {
    if (!this.buffer) return offset;
    const cur = this.visualRowOfOffset(offset);
    if (!cur || !cur.row) return offset;
    const curLc = this.buffer.offsetToLineColumn(offset);
    const curCol = clamp(curLc.column, cur.row.startCol, cur.row.endCol);
    const goalX = this.docXOfColumn(cur.row, curCol);

    const g = cur.globalRow + dir;
    if (g < 0) return 0;
    const total = this.prefix[this.prefix.length - 1];
    if (g >= total) return this.buffer.getTotalLength();

    const { line, local } = this._locateRow(g);
    const rows = this._rowsForLine(line);
    const row = rows[local];
    if (!row) return this.buffer.lineColumnToOffset(line, 0);
    row.localRow = local;

    const rw = this._rowWidth(row);
    const textLeft = (this.opts.wrap && row.dir === 'rtl') ? this.wrapWidth - rw : 0;
    let xInText = goalX - textLeft;
    xInText = clamp(xInText, 0, rw);
    let col = this.colAtX(row, xInText);
    col = clamp(col, row.startCol, row.endCol);
    return this.buffer.lineColumnToOffset(line, col);
  }

  visualLineStartOffset(offset) {
    const v = this.visualRowOfOffset(offset);
    if (!v || !v.row) return offset;
    return this.buffer.lineColumnToOffset(v.row.line, v.row.startCol);
  }

  visualLineEndOffset(offset) {
    const v = this.visualRowOfOffset(offset);
    if (!v || !v.row) return offset;
    return this.buffer.lineColumnToOffset(v.row.line, v.row.endCol);
  }

  totalVisualRows() {
    return this.prefix[this.prefix.length - 1] || 0;
  }

  refreshLayout() {
    this._applyFont();
    this.rowCache.clear();
    this._rebuildRowCounts();
    this.render();
  }
}

export default Renderer;