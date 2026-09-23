// Runs a script inside Electron (not as Node): `node scripts/run-electron.cjs <script>`.
// ELECTRON_RUN_AS_NODE, inherited from VS Code terminals, is removed for the same
// reason as in run.cjs.
const { spawn } = require('node:child_process');
const { join } = require('node:path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), process.argv.slice(2), { cwd: join(__dirname, '..'), env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
