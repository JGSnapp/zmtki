import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Counter for temp file names.
 *
 * A timestamp alone is not unique: two writes to the same target in the same
 * millisecond produced the same temp path, so the first rename moved the file
 * away and the second failed with ENOENT, silently losing a board save.
 */
let tmpCounter = 0;

/** Atomic write: temp file in the same directory, then rename. */
export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  tmpCounter += 1;
  const tmp = `${target}.${process.pid}.${Date.now()}.${tmpCounter}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readFileIfExists(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function readJsonIfExists<T>(target: string): Promise<T | undefined> {
  const text = await readFileIfExists(target);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function appendJsonl(target: string, record: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readJsonl<T>(target: string, limit?: number): Promise<T[]> {
  const text = await readFileIfExists(target);
  if (!text) return [];
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const slice = limit === undefined ? lines : lines.slice(-limit);
  const out: T[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A partially written trailing line is expected after a hard kill.
    }
  }
  return out;
}

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function hashContent(data: string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * Guards every filesystem tool against escaping the board folder. Resolves
 * symlinks where possible so a link inside the board cannot point outside it.
 */
export async function confineToRoot(root: string, candidate: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(absoluteRoot, candidate);

  const realRoot = await fs.realpath(absoluteRoot).catch(() => absoluteRoot);
  let probe = absolute;
  for (;;) {
    const real = await fs.realpath(probe).catch(() => null);
    if (real !== null) {
      const resolved = path.resolve(real, path.relative(probe, absolute));
      const rel = path.relative(realRoot, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`путь вне папки доски: ${candidate}`);
      }
      return resolved;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  const rel = path.relative(realRoot, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`путь вне папки доски: ${candidate}`);
  }
  return absolute;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export async function listFilesRecursive(
  root: string,
  options: { maxEntries?: number; ignore?: readonly string[] } = {}
): Promise<string[]> {
  const maxEntries = options.maxEntries ?? 5000;
  const ignore = new Set(options.ignore ?? ['.git', 'node_modules', 'dist', 'out', '.zmtki', 'release']);
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= maxEntries) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (ignore.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(toPosix(path.relative(root, full)));
    }
  }

  await walk(root);
  return out.sort();
}
