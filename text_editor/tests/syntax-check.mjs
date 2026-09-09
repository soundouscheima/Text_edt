import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'scripts');
for (const f of readdirSync(dir)) {
  if (f.endsWith('.js')) execFileSync(process.execPath, ['--check', join(dir, f)], { stdio: 'inherit' });
}
console.log('all scripts parsed OK');