const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electronPath = require('electron');
const vitePackagePath = require.resolve('vite/package.json');
const vitePath = path.join(path.dirname(vitePackagePath), 'bin', 'vite.js');
const result = spawnSync(electronPath, [vitePath, 'build', '--config', 'vite.config.ts'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
