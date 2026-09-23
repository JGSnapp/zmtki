import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal persistence layer: the whole collection lives in memory and is
 * written back to a JSON file with debounced, atomic writes. Swapping this for
 * a real database means reimplementing this one class.
 */
export class JsonStore<T> {
  private data: T;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    createInitial: () => T,
    private readonly debounceMs = 150,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
      } catch {
        this.data = createInitial();
      }
    } else {
      this.data = createInitial();
      this.scheduleSave();
    }
  }

  get(): T {
    return this.data;
  }

  set(next: T): T {
    this.data = next;
    this.scheduleSave();
    return this.data;
  }

  update<R>(mutator: (data: T) => R): R {
    const result = mutator(this.data);
    this.scheduleSave();
    return result;
  }

  private scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.write();
    }, this.debounceMs);
  }

  private write(): Promise<void> {
    // Compact: indentation doubled the size of a large board's file and the
    // time to serialise it on every debounced save.
    const snapshot = JSON.stringify(this.data);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, snapshot, 'utf8');
      await fs.promises.rename(tmp, this.file);
    });
    return this.writing;
  }

  /** Forces a write and waits for all pending writes to settle. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.write();
  }
}
