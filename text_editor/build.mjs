/**
 * build.mjs — creates a single self-contained index.html so the editor
 * works by simply double-clicking the file (no server needed).
 *
 * Browsers refuse to load the app as ES modules over file:// (CORS).
 * Inlining every module + stylesheet into one <script type="module">
 * and one <style> makes it work from file:// with zero tools or network.
 *
 *   npm run build
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

/* Modules in dependency order (imports before importers). */
const ORDER = [
  'util.js',
  'icons.js',
  'i18n.js',
  'buffer.js',
  'commands.js',
  'cursor.js',
  'selection.js',
  'persistence.js',
  'history.js',
  'renderer.js',
  'documents.js',
  'input.js',
  'ai.js',
  'app.js',
];

const CSS_ORDER = [
  'base.css',
  'layout.css',
  'editor.css',
  'themes.css',
  'components.css',
  'ai-panel.css',
  'rtl.css',
];

function stripImports(src) {
  // Remove every `import ... from '...';` statement (including multiline).
  return src.replace(/import\s+[\s\S]*?from\s*['"][^'"]+['"]\s*;?/g, '');
}

function stripDefaultExports(src) {
  // A module may only have one `export default`; in the flat bundle none
  // of them are imported, so drop the whole statement(s).
  return src.replace(/^\s*export\s+default\s+[\s\S]*?;\s*$/gm, '');
}

const cssParts = CSS_ORDER
  .map((f) => readFileSync(join(root, 'styles', f), 'utf8'))
  .join('\n');

const jsParts = ORDER
  .map((f) => `/* ===== ${f} ===== */\n${stripDefaultExports(stripImports(readFileSync(join(root, 'scripts', f), 'utf8')))}`)
  .join('\n');

let html = readFileSync(join(root, 'index.dev.html'), 'utf8');

html = html.split('\n').filter((line) => !/href="styles\/[^"]+\.css"/.test(line)).join('\n');
html = html.replace('  <title>Text Editor</title>',
  '  <title>Text Editor</title>\n  <style>\n' + cssParts + '\n  </style>');

html = html.split('\n').filter((line) => !/<script type="module" src="scripts\/app\.js"><\/script>/.test(line)).join('\n');
html = html.replace('</body>',
  '  <script type="module">\n' + jsParts + '\n  </script>\n</body>');

writeFileSync(join(root, 'index.html'), html, 'utf8');
console.log(`bundled index.html (${(html.length / 1024).toFixed(1)} KB)`);