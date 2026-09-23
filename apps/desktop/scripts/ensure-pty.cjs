// Makes sure a PTY binary is present without a C++ toolchain.
//
// The prebuilt fork of node-pty is built on N-API, so a binary made for any
// Node version loads in Electron as well. Its own install step tries a Node
// prebuild first and falls back to compiling with node-gyp — which fails on a
// machine without Visual Studio Build Tools and, being an install script,
// makes npm roll the whole install back. This runs after install and fetches
// the prebuild directly when the binary is missing. It never fails the install:
// without a PTY the app still starts, and terminal artifacts say why.
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const main = () => {
  let pkgDir;
  try {
    pkgDir = dirname(require.resolve('@homebridge/node-pty-prebuilt-multiarch/package.json'));
  } catch {
    console.log('[ensure-pty] package not installed, skipping');
    return;
  }
  const binary = process.platform === 'win32' ? 'conpty.node' : 'pty.node';
  if (existsSync(join(pkgDir, 'build', 'Release', binary))) {
    console.log('[ensure-pty] binary present');
    return;
  }
  let bin;
  try {
    bin = require.resolve('prebuild-install/bin.js', { paths: [pkgDir] });
  } catch {
    console.log('[ensure-pty] prebuild-install not found, skipping');
    return;
  }
  const result = spawnSync(process.execPath, [bin, '--runtime', 'node', '--target', process.versions.node], {
    cwd: pkgDir,
    stdio: 'inherit',
  });
  console.log(
    existsSync(join(pkgDir, 'build', 'Release', binary))
      ? '[ensure-pty] prebuild installed'
      : '[ensure-pty] could not fetch a prebuild (exit ' + result.status + '); terminals will be unavailable',
  );
};

try {
  main();
} catch (error) {
  console.log('[ensure-pty] ' + (error && error.message));
}
