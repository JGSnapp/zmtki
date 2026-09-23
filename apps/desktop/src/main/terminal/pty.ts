/**
 * Minimal surface of a PTY binding — the part the terminal manager uses.
 *
 * Declared here rather than imported from a package so the manager does not
 * depend on which implementation actually loaded.
 */
export interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface PtyBinding {
  /** Package the binding came from, shown in diagnostics. */
  source: string;
  spawn(file: string, args: string[], options: PtySpawnOptions): Pty;
}

/**
 * PTY packages to try, in order of preference.
 *
 * `node-pty` is the reference implementation but compiles from source, which
 * needs a C++ toolchain the machine may not have. The prebuilt fork ships
 * binaries for common Node and Electron ABIs, so it is the fallback that makes
 * terminals work on a machine without Visual Studio Build Tools.
 */
const CANDIDATES = ['node-pty', '@homebridge/node-pty-prebuilt-multiarch'] as const;

export interface PtyLoadResult {
  binding: PtyBinding | null;
  /** Why no binding loaded, ready to be shown in the terminal artifact. */
  reason?: string;
}

let cached: PtyLoadResult | null = null;

/**
 * Loads a PTY binding once per run.
 *
 * Native modules are loaded lazily rather than at import time: a binding that
 * failed to build should cost the user terminals, not the whole application.
 */
export const loadPty = async (): Promise<PtyLoadResult> => {
  if (cached) return cached;
  const failures: string[] = [];

  for (const name of CANDIDATES) {
    try {
      const module = (await import(/* @vite-ignore */ name)) as {
        spawn?: unknown;
        default?: { spawn?: unknown };
      };
      const spawn = (typeof module.spawn === 'function' ? module.spawn : module.default?.spawn) as
        | ((file: string, args: string[], options: PtySpawnOptions) => Pty)
        | undefined;
      if (!spawn) {
        failures.push(name + ': нет функции spawn');
        continue;
      }
      cached = { binding: { source: name, spawn } };
      return cached;
    } catch (error) {
      failures.push(name + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  cached = {
    binding: null,
    reason:
      'Не удалось загрузить PTY. Терминалы недоступны.\r\n' +
      failures.map((line) => '  ' + line).join('\r\n'),
  };
  return cached;
};
