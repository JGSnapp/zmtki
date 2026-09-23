// Runs electron-vite with an environment Electron can actually start in.
//
// Tools built on Electron — VS Code and its terminals among them — export
// ELECTRON_RUN_AS_NODE=1 to their child processes. Inherited by our app, it
// makes electron.exe behave as plain Node: `require('electron')` fails and no
// window ever opens. It is removed here rather than in each npm script so the
// scripts stay cross-platform.
const { spawn } = require('node:child_process');
const { join } = require('node:path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Launched from inside a Claude Code session, these would make a harness
// started on the board believe it is nested in that session.
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

const bin = join(require.resolve('electron-vite/package.json'), '..', 'bin', 'electron-vite.js');
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  cwd: join(__dirname, '..'),
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
