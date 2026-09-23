// Builds the app, opens it on a generated board, flies the camera over it and
// quits, appending the frame-time report to <data dir>/bench.jsonl.
//
//   npm run bench                 # 5000 artifacts
//   npm run bench -- 10000        # any count
//
// A throwaway data directory keeps benchmark boards out of the user's own.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const count = Number(process.argv[2]) || 5000;
const dataDir = process.env.ZMTKI_DATA_DIR || mkdtempSync(join(tmpdir(), 'zmtki-bench-'));
const run = join(__dirname, 'run.cjs');

const build = spawnSync(process.execPath, [run, 'build'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

spawnSync(process.execPath, [run, 'preview', '--skipBuild'], {
  stdio: 'inherit',
  env: { ...process.env, ZMTKI_BENCH: String(count), ZMTKI_BENCH_QUIT: '1', ZMTKI_DATA_DIR: dataDir },
});

try {
  const lines = readFileSync(join(dataDir, 'bench.jsonl'), 'utf8').trim().split('\n');
  console.log(JSON.stringify(JSON.parse(lines[lines.length - 1]), null, 2));
} catch {
  console.error('No report was written to ' + dataDir);
  process.exit(1);
}
