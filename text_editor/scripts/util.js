/* ============================================================
   util.js — dependency-free helpers: Unicode segmentation,
   word boundaries (Latin + Arabic), bidi/RTl detection,
   misc formatting & DOM helpers.
   ============================================================ */

/* ---- Grapheme segmentation ---------------------------------
   Intl.Segmenter('en', {granularity:'grapheme'}) treats a
   grapheme cluster as the user-perceived "character". This is what
   we use for Left/Right/Backspace and click-to-position so an
   Arabic diacritic or an emoji ZWJ sequence moves the caret whole.
   If Intl.Segmenter is unavailable (very old browsers) we degrade
   to code-unit stepping. */
const segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme', localeMatcher: 'lookup' })
  : null;

/** Cached segmentation of a string (position cache). */
export function iterGraphemes(text, start = 0, end = text.length) {
  if (segmenter) {
    return segmenter.segment(text.slice(start, end));
  }
  return null;
}

export function hasSegmentation() { return !!segmenter; }

/** Offset of the grapheme boundary BEFORE index (prev visual char). */
export function prevGrapheme(text, index) {
  if (index <= 0) return 0;
  if (!segmenter) return index - 1;
  const start = Math.max(0, index - 12);
  const it = segmenter.segment(text.slice(start, index))[Symbol.iterator]();
  let prev = start;
  for (let g = it.next(); !g.done; g = it.next()) prev = start + g.value.index;
  return prev;
}

/** Offset of the grapheme boundary AFTER index (next visual char). */
export function nextGrapheme(text, index) {
  if (index >= text.length) return text.length;
  if (!segmenter) return index + 1;
  const it = segmenter.segment(text.slice(index))[Symbol.iterator]();
  const g = it.next();
  if (g.done) return text.length;
  return index + g.value.segment.length;
}

/* ---- Word boundaries ---------------------------------------- */

/** Latin letters, Arabic letters, digits, underscore, combining marks. */
export function isWordChar(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  // ASCII letters & digits
  if (c >= 48 && c <= 57) return true;
  if (c >= 65 && c <= 90) return true;
  if (c >= 97 && c <= 122) return true;
  if (c === 95) return true;
  // Arabic block + Arabic presentation forms + combining diacritics
  if (c >= 0x0600 && c <= 0x06FF) return true;
  if (c >= 0x0750 && c <= 0x077F) return true;
  if (c >= 0x08A0 && c <= 0x08FF) return true;
  if (c >= 0xFB50 && c <= 0xFDFF) return true;
  if (c >= 0xFE70 && c <= 0xFEFF) return true;
  if (c >= 0x0300 && c <= 0x036F) return true;
  // Extended Latin
  if (c >= 0xC0 && c <= 0x2AF) return true;
  return false;
}

/** Index of the start of the word containing `index` (exclusive).
    index is a UTF-16 offset. */
export function wordStart(text, index) {
  while (index > 0 && isWordChar(text[index - 1])) index--;
  return index;
}

/** Index just past the end of the word containing `index`. */
export function wordEnd(text, index) {
  const n = text.length;
  while (index < n && isWordChar(text[index])) index++;
  return index;
}

export function isWordCharAt(text, index) {
  return index >= 0 && index < text.length && isWordChar(text[index]);
}

/* ---- Arabic / RTL detection ---------------------------------- */

export function isArabicCharCode(cp) {
  return (cp >= 0x0600 && cp <= 0x06FF) ||
         (cp >= 0x0750 && cp <= 0x077F) ||
         (cp >= 0x08A0 && cp <= 0x08FF) ||
         (cp >= 0xFB50 && cp <= 0xFDFF) ||
         (cp >= 0xFE70 && cp <= 0xFEFF);
}

/** Weighted majority direction heuristic for a line of text.
    Returns 'rtl' | 'ltr' | 'neutral'. Counts strong-direction
    characters, ignoring digits and punctuation. */
export function detectLineDirection(text) {
  let rtl = 0, ltr = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isArabicCharCode(cp)) rtl++;
    else if ((cp >= 0x0041 && cp <= 0x005A) ||
             (cp >= 0x0061 && cp <= 0x007A) ||
             (cp >= 0x00C0 && cp <= 0x02AF)) ltr++;
  }
  if (rtl > ltr) return 'rtl';
  if (ltr > rtl) return 'ltr';
  return 'neutral';
}

/* ---- Misc ----------------------------------------------------- */

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  d.flush = () => { if (t) { clearTimeout(t); fn(); } };
  return d;
}

export function throttle(fn, ms) {
  let last = 0, t = null;
  const th = (...args) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) { last = now; fn(...args); }
    else if (!t) t = setTimeout(() => { last = Date.now(); t = null; fn(...args); }, wait);
  };
  th.cancel = () => { clearTimeout(t); t = null; };
  return th;
}

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function formatNumber(n) { return n.toLocaleString(); }

/** Trigger a Blob download purely client-side. */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

export function readingTime(text) {
  const words = (text.trim().match(/\S+/g) || []).length;
  const cpm = 220;
  const mins = Math.max(1, Math.round(words / cpm));
  if (mins < 1) return '~1 min';
  return `${mins} min`;
}

export function samePosition(a, b) { return a.line === b.line && a.column === b.column; }

/* Deterministic-ish random id. */
export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export { };
export default {
  prevGrapheme, nextGrapheme, hasSegmentation, isWordChar, wordStart, wordEnd,
  detectLineDirection, isArabicCharCode, clamp, debounce, throttle,
  escapeHtml, formatNumber, downloadBlob, readingTime, samePosition, uid,
};