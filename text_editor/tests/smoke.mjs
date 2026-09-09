import { PieceTableBuffer } from '../scripts/buffer.js';
import { Cursor } from '../scripts/cursor.js';
import { Selection } from '../scripts/selection.js';
import { InsertTextCommand, DeleteTextCommand, ReplaceSelectionCommand } from '../scripts/commands.js';
import { HistoryManager } from '../scripts/history.js';
import { Document, findInDoc } from '../scripts/documents.js';
import { i18n } from '../scripts/i18n.js';
import { nextGrapheme, prevGrapheme, isWordCharAt, detectLineDirection } from '../scripts/util.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.log('FAIL:', name); }
}

function newDoc(text) {
  const d = new Document({ name: 't', id: 't' });
  if (text) d.replaceRange(0, 0, text);
  return d;
}
const caret = (d) => d.buffer.lineColumnToOffset(d.cursor.line, d.cursor.column);

// --- buffer ---
{
  const b = new PieceTableBuffer('Hello');
  check('buffer len', b.getTotalLength() === 5);
  b.insert(5, ' World');
  check('insert append', b.getText() === 'Hello World');
  const d2 = b.insert(5, ',');
  check('insert mid', b.getText() === 'Hello, World');
  const d3 = b.delete(5, 1);
  check('delete mid', b.getText() === 'Hello World');
  b.undo(d2);
  check('undo insert', b.getText() === 'Hello World');
  b.redo(d2);
  check('redo insert', b.getText() === 'Hello, World');
  b.undo(d3);
  check('undo delete', b.getText() === 'Hello, World');
  b.redo(d3);
  check('redo delete', b.getText() === 'Hello World');
  check('line count', b.getLineCount() === 1);
  b.insert(5, '\n');
  check('line count after nl', b.getLineCount() === 2);
  const pos = b.offsetToLineColumn(7);
  check('offsetToLineColumn', pos.line === 1 && pos.column === 1);
  check('lineColumnToOffset roundtrip', b.lineColumnToOffset(pos.line, pos.column) === 7);
  check('getLine', b.getLine(0) === 'Hello' && b.getLine(1) === ' World');
  const s = b.serialize();
  const b2 = PieceTableBuffer.deserialize(s);
  check('serialize/deserialize', b2.getText() === b.getText());
}

// --- graphemes / words / bidi ---
{
  check('nextGrapheme ascii', nextGrapheme('abc', 1) === 2);
  check('prevGrapheme ascii', prevGrapheme('abc', 2) === 1);
  const emoji = 'a\u{1F600}b';
  check('nextGrapheme emoji', nextGrapheme(emoji, 1) === 3);
  check('prevGrapheme emoji', prevGrapheme(emoji, 3) === 1);
  check('word char latin', isWordCharAt('hello world', 0) === true);
  check('word space', isWordCharAt('hello world', 5) === false);
  check('word arabic', isWordCharAt('\u0627\u0644\u0633\u0644\u0627\u0645', 0) === true);
  check('dir latin', detectLineDirection('hello') === 'ltr');
  check('dir arabic', detectLineDirection('\u0645\u0631\u062d\u0628\u0627') === 'rtl');
  check('dir mixed leads rtl', detectLineDirection('\u0645\u0631\u062d\u0628\u0627\u064b hello') === 'rtl');
  check('dir tie neutral', detectLineDirection('\u0645\u0631\u062d\u0628\u0627 hello') === 'neutral');
}

// --- commands / history ---
{
  const d = newDoc('Hello');
  const h = d.history;
  h.beginGroup('type');
  let g = h.openGroup;
  const c1 = new InsertTextCommand(5, '!');
  c1.execute(d); g.add(c1);
  const c2 = new InsertTextCommand(6, '?');
  c2.execute(d); g.add(c2);
  h.endGroup();
  check('grouped typing applied', d.text === 'Hello!?');
  check('caret after typing', caret(d) === 7);
  d.undo();
  check('undo whole typing group', d.text === 'Hello');
  check('caret after undo', caret(d) === 5);
  d.redo();
  check('redo whole typing group', d.text === 'Hello!?');
  check('caret after redo', caret(d) === 7);

  d.deleteWordBefore();
  check('deleteWordBefore (whole token)', d.text === '');
  d.undo();
  check('undo word delete', d.text === 'Hello!?');

  const wd = newDoc('Hello World!');
  wd.cursor.setPosition(0, 12, { resetGoal: true });
  wd.deleteWordBefore();
  check('deleteWordBefore (space boundary)', wd.text === 'Hello ');
  wd.deleteBefore();
  check('deleteBefore (the space)', wd.text === 'Hello');
  wd.deleteWordBefore();
  check('deleteWordBefore (whole first word)', wd.text === '');
  wd.undo(); wd.undo(); wd.undo();
  check('undo three word deletes', wd.text === 'Hello World!');

  d.setSelection(2, 4);
  d.typeText('ZZ');
  check('replace selection via type', d.text === 'HeZZo!?');
  d.undo();
  check('undo replace selection', d.text === 'Hello!?');

  // direct command-level test
  const dc = newDoc('abc');
  const cmd = new DeleteTextCommand(1, 'b');
  cmd.execute(dc);
  check('direct delete cmd', dc.text === 'ac');
  cmd.undo(dc);
  check('direct undo cmd', dc.text === 'abc');

  // replaceRange atomic
  const rr = newDoc('the quick fox');
  rr.replaceRange(4, 9, 'slow');
  check('replaceRange', rr.text === 'the slow fox');
  rr.undo();
  check('replaceRange undo', rr.text === 'the quick fox');

  // multiline + select all + delete
  const ml = newDoc('one\ntwo\nthree');
  check('multiline count', ml.buffer.getLineCount() === 3);
  ml.setSelection(0, ml.text.length);
  ml.deleteAfter();
  check('delete all via selection', ml.text === '');

  // history cap
  const cap = newDoc('');
  const lim = cap.history.limit;
  for (let i = 0; i < lim + 50; i++) { cap.replaceRange(0, 0, 'x'); }
  check('history capped', cap.history.undoStack.length === lim);
}

// --- findInDoc ---
{
  const d = newDoc('The quick brown fox jumps over the lazy dog. The end.');
  check('find ci matches', findInDoc(d, 'the', { caseSensitive: false }).length === 3);
  check('find cs matches', findInDoc(d, 'The', { caseSensitive: true }).length === 2);
  check('find whole word', findInDoc(d, 'fox', { wholeWord: true }).length === 1);
  const rx = findInDoc(d, 'q\\w+k', { regex: true });
  check('find regex', rx.length === 1 && d.text.slice(rx[0].start, rx[0].end) === 'quick');
  check('find regex cs no match', findInDoc(d, 'THE', { regex: true, caseSensitive: true }).length === 0);
  check('find none', findInDoc(d, 'zzz', {}).length === 0);
}

// --- cursor goal column ---
{
  const c = new Cursor(0, 10);
  check('goal init', c.goalColumn === 10);
  c.setPosition(1, 3, { resetGoal: true });
  check('horizontal reset', c.goalColumn === 3);
  c.setPosition(2, 2);
  check('vertical keeps goal', c.goalColumn === 3);
  const o = c.clone();
  check('clone', o.equals(c) && o.goalColumn === 3);
  const s = c.serialize();
  const c2 = Cursor.deserialize(s);
  check('cursor roundtrip', c2.line === 2 && c2.column === 2);
}

// --- selection ---
{
  const s = new Selection(5, 2);
  check('sel start/end', s.start === 2 && s.end === 5);
  check('sel forward', s.isForward() === false);
  s.extend(8);
  check('sel extend', s.start === 5 && s.end === 8);
  s.collapse();
  check('sel collapse', s.isEmpty);
  const s2 = Selection.deserialize(s.serialize());
  check('sel roundtrip', s2.anchor === s.anchor && s2.head === s.head);
}

// --- i18n (DOM-free subset; setLocale needs a document) ---
{
  const en = i18n.t('appName');
  check('i18n resolves key', typeof en === 'string' && en.length > 0);
  check('i18n missing key fallback', i18n.t('definitely___missing') === 'definitely___missing');
  check('i18n var interpolation', i18n.t('resultsCount', { n: 42 }) === '42 results' || i18n.t('resultsCount', { n: 42 }).indexOf('42') !== -1);
}

// --- fuzz: buffer vs naive string model ---
{
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const b = new PieceTableBuffer('The quick brown fox jumps.\nLine two here.');
  let s = b.getText();
  let ok = true;
  for (let k = 0; k < 3000; k++) {
    const r = rnd();
    if (r < 0.5) {
      const off = Math.floor(rnd() * (s.length + 1));
      const frags = ['\n', ' ', 'abc', 'x' + Math.floor(rnd() * 999), '\u0645\u0631\u062d\u0628\u0627', '\u{1F600}', 'z'];
      const frag = frags[Math.floor(rnd() * frags.length)];
      b.insert(off, frag);
      s = s.slice(0, off) + frag + s.slice(off);
    } else {
      const off = Math.floor(rnd() * s.length);
      const len = Math.floor(rnd() * Math.min(10, s.length - off));
      b.delete(off, len);
      s = s.slice(0, off) + s.slice(off + len);
    }
    if (b.getText() !== s) {
      console.log('fuzz text mismatch at step', k);
      ok = false; break;
    }
    const off = Math.floor(rnd() * (s.length + 1));
    const pos = b.offsetToLineColumn(off);
    const model = s.slice(0, off).split('\n').length - 1;
    const nl = s.lastIndexOf('\n', off - 1);
    const col = off === 0 ? 0 : off - nl - 1;
    if (pos.line !== model || pos.column !== col) {
      console.log('fuzz coord mismatch at step', k, 'offset', off);
      ok = false; break;
    }
  }
  check('fuzz 3000 ops against string model', ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
