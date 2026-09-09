# TextForge — a vanilla, bilingual text editor with a built-in AI assistant

A complete text editor that runs entirely in the browser — **no frameworks, no
build step, no backend, no third-party editor libraries**. Fully bilingual
(English / العربية, LTR / RTL) with a toggleable AI assistant panel that works
with Gemini, DeepSeek, Kimi, OpenAI, or any OpenAI-compatible endpoint.

## Running it

There is nothing to install or build. Copy the folder anywhere and double-click
`index.html` — it is a **single self-contained file** (all styles and modules
inlined), so browsers can't block it. It works fully offline; all data lives in
IndexedDB + localStorage, and nothing is uploaded except AI requests you start.

## Working on the code

The source lives in `scripts/` (ES modules), `styles/`, and `index.dev.html`.
`index.html` is generated from those by a tiny zero-dependency bundler (needed
because browsers refuse external ES modules over `file://`):

```sh
npm run build      # regenerates the self-contained index.html
npm run check      # syntax-check every module
npm test           # run the logic test suite (66 assertions)
```

## Feature overview

- **Pure-logic editing core** — custom text buffer (piece table), custom
  cursor with sticky-goal-column behavior, offset-based selection, and a
  Command-pattern undo/redo system. No `<textarea>` or `contenteditable` is
  used to host the document; a 1-pixel invisible `<textarea>` only captures
  native text/IME input.
- **Word wrap** with separate logical (lines) and visual (rows) layers,
  grapheme-safe (emoji, Arabic diacritics) via `Intl.Segmenter`.
- **RTL support** — automatic per-line direction detection, mirrored
  Left/Right/word navigation, right-anchored caret math.
- **Autosave** to IndexedDB (debounced 500 ms, flushed on tab hide / unload)
  with document tabs, per-doc scroll/cursor restoration, and version
  snapshots every 2 minutes (restorable from the sidebar).
- **Find & replace** (case-sensitive, whole-word, regex), outline, Markdown
  preview, live statistics, focus mode, export to `.txt`/`.md`.
- **AI assistant panel** — sidebar chat with quick actions (summarize,
  translate, continue). AI responses can be inserted into the document as one
  atomic, undoable edit.

## Project layout

```
index.html              App shell; loads scripts/app.js as an ES module.
styles/                 base, layout, editor, themes, components,
                        ai-panel, rtl
scripts/
  util.js               Grapheme/word segmentation, bidi detection, helpers.
  icons.js              Inline SVG icon strings.
  buffer.js             PieceTableBuffer — the core data structure (below).
  cursor.js             Cursor {line,column} + sticky goalColumn/goalX.
  selection.js          Selection stored as anchor/head offsets.
  commands.js           Command pattern (Insert/Delete/Replace/Composite).
  history.js            Undo/redo stacks + typed-burst grouping.
  renderer.js           Visual layer: wrapping, RTL rows, hit-testing,
                        virtualized DOM rows, selection paints.
  input.js              Keyboard/mouse/IME events → commands.
  i18n.js               EN/AR dictionaries + DOM translation.
  persistence.js        IndexedDB (docs/settings/versions/session/recents)
                        + localStorage helpers.
  documents.js          Document = buffer + cursor + selection + history;
                        findInDoc.
  ai.js                 Provider adapters (Gemini, OpenAI-compatible) +
                        assistant panel UI.
  app.js                Boot, UI wiring, tabs, status bar, modals, tour.
```

## Why a piece table?

`buffer.js` keeps the rationale inline; the short version:

| Approach          | Cost of an edit | Memory per edit         | Notes |
|-------------------|-----------------|-------------------------|-------|
| String splice     | O(n) copy       | O(n)                    | 1 MB doc → 1 MB copied per keystroke |
| Rope / gap buffer | O(log n)–O(1)   | O(edit) + O(doc)        | Great, but a lot more code |
| **Piece table**   | O(pieces)       | O(diff only), undo is O(p) and copies no text | Used by VS Code / Word |

- `original` — one immutable string (the file as first loaded).
- `add` — an append-only array of chunks; **every edit appends one new chunk**
  and appends/replaces pieces. Chunks are never mutated, which makes undo
  *structural*: `insert()`/`delete()` return `{before, after}` piece-list
  snapshots, and undo/redo just swap which list is active — no text copying.
- Pieces are `{src:'ori'|'add', chunk, start, len}`; `start` is the offset
  *inside* that source. Adjacent pieces that tile the same source without gaps
  are merged to keep the piece count small during typing bursts.

Tradeoffs (documented in-code): the line index (`_lineStarts`) is rebuilt with
one scan per edit (O(n), tiny constant); a balanced tree would scale to 10⁶+
lines but was not worth the complexity here.

## Undo/redo architecture

- Every edit is a **Command** holding only the diff, not the whole document:
  `InsertTextCommand`, `DeleteTextCommand`, `ReplaceSelectionCommand`,
  `CompositeCommand`.
- Commands snapshot the cursor *before* they run and move the caret to the
  natural post-edit position afterwards — callers never track caret placement.
- **Typed bursts** ("hello") are grouped into one `CompositeCommand` so a keystroke
  group undoes as a single step. An explicit action (Delete, paste, AI insert,
  cursor move) commits the open group first.
- History is capped at 800 entries. Undo history is deliberately **not**
  persisted across reloads: command offsets are absolute and would silently
  corrupt the document if restored text differed from the text the commands
  were recorded against (full rationale in `history.js`). The reliable 98%
  case — content, cursor, scroll, tabs — *is* persisted.

## Persistence & storage

| Store            | What                          | Why localStorage/IDB |
|------------------|-------------------------------|----------------------|
| IndexedDB `docs`     | Document text + cursor + title + per-doc chat | Survives reload, large docs |
| IndexedDB `settings` | UI prefs (theme, lang, font, wrap…)        | Cheap, sync-friendly |
| IndexedDB `versions` | Auto-snapshots every 2 min                 | Restore earlier content |
| IndexedDB `session`  | Tab order + active tab                      | Restore your workspace |
| IndexedDB `recents`  | Recently opened documents                   | Quick access |
| localStorage      | Same settings + `ai.*` config (provider + key) | Sync-friendly |

Quota errors are caught: the app prunes and shows a warning rather than
silently losing data. See `persistence.js` for the exact store schemas.

## AI assistant setup

1. Open the AI panel (sidebar button or `Ctrl+J`).
2. Choose a provider:
   - **Gemini** — `https://generativelanguage.googleapis.com/v1beta` (built-in);
     key from Google AI Studio.
   - **DeepSeek / Kimi / OpenAI** — `https://api.deepseek.com`, `https://api.moonshot.ai`,
     `https://api.openai.com/v1` respectively (pre-filled, editable).
   - **Custom** — any OpenAI-compatible endpoint.
3. Paste your API key and press **Test connection**.

> Your key is stored in your browser's `localStorage` (`te.ai.key`) and is sent
> **only** to the provider you selected. It is visible to anyone with access to
> that browser profile — treat it like any browser-stored credential.

Requests are made straight from the browser (Gemini REST, and the OpenAI
`/chat/completions` streaming for OpenAI-compatible providers). Offline, the
panel shows a friendly "you're offline" state and the AI features are disabled.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` / `Ctrl+O` / `Ctrl+W` | Save / open file / close tab |
| `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) | Undo / redo |
| `Ctrl+F` / `Ctrl+H` | Find / replace |
| `Ctrl+A` / `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Standard edit ops |
| `Ctrl+Left/Right`, `Ctrl+Backspace/Delete` | Word navigation/deletion |
| `Ctrl+Home` / `Ctrl+End` | Document start / end |
| `Ctrl+G` | Go to line |
| `Ctrl+J` | Toggle AI panel |
| `Ctrl+Shift+F` | Focus mode |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Ctrl+B` | Bold in Markdown documents |
| `Ctrl+1..5` | Toggle sidebar (outline / preview / stats / versions / recents) |

Full list is available in the editor via **Help → Keyboard shortcuts** (`F1`).

## Tests

The DOM-free core (`buffer`, `commands`, `history`, `documents`, `util`,
`i18n`, `cursor`, `selection`) is exercised by a Node smoke test, including a
3 000-operation fuzz against a naive string model that also cross-checks
offset↔line/column mapping:

```sh
npm test              # == node tests/smoke.mjs
npm run check         # == node tests/syntax-check.mjs  (syntax)
```

A manual test checklist is included in the conversation; the goal-column,
typed-burst undo, reload, and RTL cases are called out in `cursor.js` /
`renderer.js` / `history.js`.