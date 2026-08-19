const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, 'chatgpt-proxy-bookmarklet.js');
const outputPath = path.join(__dirname, 'chatgpt-proxy-bookmarklet.txt');
const source = fs.readFileSync(sourcePath, 'utf8')
  .replace(/\/\/.*$/gm, '')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{}();,:?])\s*/g, '$1')
  .trim();

fs.writeFileSync(outputPath, `javascript:${source}\n`);
console.log(outputPath);
