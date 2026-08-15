const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const roots = ['src', 'scripts', 'test'];
const files = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.name.endsWith('.js')) files.push(target);
  }
}

roots.forEach(walk);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Checked ${files.length} JavaScript files.`);
