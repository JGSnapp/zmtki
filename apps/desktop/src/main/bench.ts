import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchReport } from '../shared/ipc.js';

/**
 * Appends one benchmark run as a JSON line. A log rather than a single file,
 * so runs before and after a change sit next to each other.
 */
export const writeBenchReport = (dataDir: string, report: BenchReport): void => {
  mkdirSync(dataDir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...report });
  appendFileSync(join(dataDir, 'bench.jsonl'), line + '\n', 'utf8');
  console.log('[bench] ' + line);
};
