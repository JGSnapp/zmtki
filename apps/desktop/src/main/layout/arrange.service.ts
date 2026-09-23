import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ArrangeOptions, ArrangeResult, Arrow, Artifact, RouteOptions } from '@zmtki/shared';
import {
  portTrials,
  runArrange,
  type ArrangeFailure,
  type ArrangeReply,
  type ArrangeRequest,
  type RouteReply,
  type RouteRequest,
} from './arrange.run.js';

/** How long one call may take before the search settles for what it has. */
const DEFAULT_BUDGET_MS = 6000;

/**
 * What routing may spend on the attachment search.
 *
 * Upstream it runs unbudgeted, and on the boards it was measured on — a dozen
 * nodes — it finishes in seconds. The trial count this allows comes out above
 * the engine's own ceiling for boards that size, so they are laid exactly as
 * upstream lays them. It binds only on boards bigger than any teca measured,
 * where the fourth move type (32 routing calls per tangled arrow) otherwise
 * runs past the agent's own timeout. Measured on a 30-node board: 700 trials
 * took 53 s, and halving the allowance brought it to about half that, while a
 * 12-node board is allowed 2381 — more than the engine will ever use.
 */
const ROUTE_BUDGET_MS = 10_000;

/**
 * Hard stops. The budget steers the arrangement between candidates, but a
 * single candidate cannot be interrupted from outside, so a graph big enough to
 * blow through this gets the thread killed and an answer the agent can act on.
 * Routing gets longer rope: it runs unbudgeted, to match what the board tool
 * produced before this moved off the main thread.
 */
const HARD_LIMIT_MS = { arrange: 30_000, route: 90_000 };

export interface ArrangeOutcome {
  result: ArrangeResult;
  /** Candidates weighed, out of those planned — fewer means the budget cut in. */
  tried: number;
  planned: number;
  ms: number;
}

/**
 * Runs the layout engine on a worker thread.
 *
 * Arranging a graph is seconds of unbroken CPU, and it used to run right here,
 * between an agent's request and its answer: the window stopped repainting, the
 * user saw "not responding", and on a 30-node board the agent's own call timed
 * out after a minute. Nothing about that is fixable by making the engine a bit
 * faster — it is a search, and searches take as long as they take. It belongs
 * off the thread that has to answer the window.
 *
 * Two jobs go through here: arranging a graph (deciding where the nodes go) and
 * routing (drawing the lines for nodes that are already placed).
 */
export class ArrangeService {
  private worker: Worker | null = null;
  private busy: Promise<unknown> = Promise.resolve();

  /** Positions and routed arrows for this graph, computed off the main thread. */
  async arrange(
    artifacts: Artifact[],
    arrows: Arrow[],
    options: ArrangeOptions = {},
    budgetMs = DEFAULT_BUDGET_MS,
  ): Promise<ArrangeOutcome> {
    const reply = await this.queue<ArrangeReply>({ artifacts, arrows, options, budgetMs }, HARD_LIMIT_MS.arrange);
    return { result: reply.result, tried: reply.tried, planned: reply.planned, ms: reply.ms };
  }

  /**
   * Lines for nodes that are already placed: routing plus the attachment
   * search, the same two steps and the same engine calls as before, moved off
   * the main thread. No budget by default — the result has to match what the
   * board tool produced when it ran this inline.
   */
  route(
    artifacts: Artifact[],
    arrows: Arrow[],
    options: RouteOptions = {},
    lockedArrowIds: string[] = [],
  ): Promise<RouteReply> {
    return this.queue<RouteReply>(
      {
        kind: 'route',
        artifacts,
        arrows,
        options,
        lockedArrowIds,
        portTrials: portTrials(artifacts.length, arrows.length, ROUTE_BUDGET_MS),
      },
      HARD_LIMIT_MS.route,
    );
  }

  /**
   * One call at a time: two of these at once would each take a thread, and the
   * machine would spend its cores on work nobody is waiting for.
   */
  private queue<T extends ArrangeReply | RouteReply>(request: ArrangeRequest | RouteRequest, limitMs: number): Promise<T> {
    const mine = this.busy.then(
      () => this.send<T>(request, limitMs),
      () => this.send<T>(request, limitMs),
    );
    this.busy = mine.catch(() => undefined);
    return mine;
  }

  private send<T extends ArrangeReply | RouteReply>(request: ArrangeRequest | RouteRequest, limitMs: number): Promise<T> {
    const worker = this.ensureWorker();
    if (!worker) {
      // No bundled worker beside us — a unit test, or a build that did not
      // produce one. The same code runs here, just on this thread.
      const reply = runArrange(request);
      return reply.ok ? Promise.resolve(reply as T) : Promise.reject(new Error((reply as ArrangeFailure).error));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        // The thread is stuck inside one candidate and cannot be asked to stop.
        void this.worker?.terminate();
        this.worker = null;
        reject(
          new Error(
            'Расчёт не уложился в ' +
              Math.round(limitMs / 1000) +
              ' с: граф слишком большой для одного вызова. Возьми его частями — nodeIds на подсистему, ' +
              'остальные узлы в lockIds, — или задай direction вместо auto.',
          ),
        );
      }, limitMs);

      const onMessage = (reply: ArrangeReply | ArrangeFailure | RouteReply) => {
        cleanup();
        if (!reply.ok) reject(new Error(reply.error));
        else resolve(reply as T);
      };
      const onError = (error: Error) => {
        cleanup();
        this.worker = null;
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
      };

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage(request);
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    // Built next to the main bundle by electron-vite (see electron.vite.config).
    const file = join(import.meta.dirname, 'arrange.worker.js');
    if (!existsSync(file)) return null;
    const worker = new Worker(file);
    // The thread outlives single calls; nothing keeps the app alive because of it.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = null;
  }
}
