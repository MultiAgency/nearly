#!/usr/bin/env node
const { chmodSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const target = resolve(__dirname, '..', 'dist', 'cli', 'index.js');
const shebang = '#!/usr/bin/env node\n';
const current = readFileSync(target, 'utf8');
if (!current.startsWith(shebang)) {
  writeFileSync(target, shebang + current);
}
chmodSync(target, 0o755);
