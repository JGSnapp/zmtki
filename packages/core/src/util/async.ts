export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Trailing debounce that also guarantees a flush after `maxWaitMs`, so a board
 * under continuous agent writes still reaches disk instead of being starved.
 */
export function debounceWithMaxWait(
  fn: () => void | Promise<void>,
  waitMs: number,
  maxWaitMs: number
): { schedule: () => void; flush: () => Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let firstCallAt = 0;
  let running: Promise<void> | null = null;

  const invoke = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    firstCallAt = 0;
    running = Promise.resolve(fn()).catch((err) => {
      console.error('[debounce] flush failed', err);
    });
    await running;
    running = null;
  };

  return {
    schedule() {
      const now = Date.now();
      if (firstCallAt === 0) firstCallAt = now;
      if (timer) clearTimeout(timer);
      const elapsed = now - firstCallAt;
      const delay = Math.max(0, Math.min(waitMs, maxWaitMs - elapsed));
      timer = setTimeout(() => void invoke(), delay);
    },
    async flush() {
      if (timer || firstCallAt !== 0) await invoke();
      else if (running) await running;
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      firstCallAt = 0;
    }
  };
}

/** Runs tasks with bounded concurrency, preserving result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
