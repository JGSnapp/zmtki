export type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (err) {
        console.error('[emitter] listener threw', err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}
