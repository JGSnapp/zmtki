import {
  arrangeGraph,
  boardQuality,
  routeArrows,
  searchPorts,
  type ArrangeOptions,
  type ArrangeResult,
  type Arrow,
  type Artifact,
  type LayoutDirection,
  type RouteOptions,
  type RouteResult,
} from '@zmtki/shared';

/**
 * The layout engine, on a thread of its own.
 *
 * `arrangeGraph` is a search: it lays the graph out several ways and scores
 * each one with the same geometry checks the rest of the system uses. That is
 * seconds of straight-line CPU on a middling graph and minutes on a big one —
 * measured 4 s at 11 nodes, 229 s at 30 — and while it runs nothing else in
 * that thread happens. Run in the main process it froze the window and the
 * agent's call timed out; here it costs a message round trip and the app stays
 * answering.
 *
 * The thread also makes the search interruptible in the only way that matters:
 * candidates are tried one at a time, best kept, and the run stops when the
 * budget is spent instead of when the engine is done.
 */
export interface ArrangeRequest {
  kind?: 'arrange';
  artifacts: Artifact[];
  arrows: Arrow[];
  options: ArrangeOptions;
  /** How long the whole search may take. The first candidate always runs. */
  budgetMs: number;
}

export interface ArrangeReply {
  ok: true;
  result: ArrangeResult;
  /** Candidates actually tried, and whether the budget cut the search short. */
  tried: number;
  planned: number;
  ms: number;
}

export interface ArrangeFailure {
  ok: false;
  error: string;
}

/**
 * The other half of the job: the nodes are where someone wanted them, and only
 * the lines have to be drawn. Routing is the cheap part — it is the search over
 * placements that costs minutes — but it is the same kind of work, so it runs
 * on the same thread.
 */
export interface RouteRequest {
  kind: 'route';
  artifacts: Artifact[];
  arrows: Arrow[];
  options: RouteOptions;
  /** Arrows whose attachment the caller pinned; the port search leaves them alone. */
  lockedArrowIds: string[];
  /**
   * Cap on port-search trials. Left out, the engine's own budget applies —
   * which is what the playground does and what small boards should keep.
   */
  portTrials?: number;
  ms?: number;
}

export interface RouteReply {
  ok: true;
  kind: 'route';
  /** Everything the router reported, as the board tool used to get it. */
  result: RouteResult;
  /** Arrows after the port search, when it improved on what routing produced. */
  ports: Arrow[] | null;
  portSwaps: number;
  refused: boolean;
  note: string;
  ms: number;
}

/** Directions to try when the caller did not fix one. */
const DIRECTIONS: LayoutDirection[] = ['LR', 'TB'];
/** The engine's own steps, kept in step with `arrangeGraph` (layout.ts). */
const DEFAULT_SCALES = [0.7, 0.85, 1, 1.3];

/**
 * How many port moves the attachment search may weigh, for a graph this size.
 *
 * That search is where the time goes: measured on 24 nodes and 30 arrows, its
 * 1600 trials took 29 s of the arrangement's 30, and the same layout without it
 * took 0.6 s — and scored 24 out of 100 instead of 100. So it is not something
 * to switch off; it is something to give a budget. One trial re-routes an arrow
 * and re-scores the board, which costs about `0.025 ms × nodes × arrows` on
 * that measurement, and the count below is what fits the time allowed.
 *
 * Small boards stay exactly as the engine would do them on its own: the number
 * comes out above the engine's own ceiling and the cap never binds.
 */
/** The same clamp `applyRoute` puts on a port offset before it is stored. */
const clampOffset = (value: number | null | undefined): number | undefined =>
  value == null || !Number.isFinite(value) ? undefined : Math.min(1, Math.max(0, value));

export const portTrials = (nodes: number, arrows: number, budgetMs: number): number => {
  const perTrialMs = Math.max(0.5, 0.025 * nodes * Math.max(1, arrows));
  return Math.max(60, Math.round(budgetMs / perTrialMs));
};

const runLayout = (request: ArrangeRequest): ArrangeReply | ArrangeFailure => {
  const { artifacts, arrows, options, budgetMs } = request;
  const directions = options.direction && options.direction !== 'auto' ? [options.direction] : [...DIRECTIONS];
  const scales = options.spacingSteps ?? DEFAULT_SCALES;
  const plan: Array<{ direction: LayoutDirection; scale: number }> = [];
  for (const direction of directions) for (const scale of scales) plan.push({ direction, scale });

  const started = Date.now();
  let best: ArrangeResult | null = null;
  let tried = 0;
  // The whole budget goes to the first candidate; later ones only run if it
  // came back quickly, and they are cheaper for the same reason.
  const trials = portTrials(artifacts.length, arrows.length, budgetMs);

  for (const candidate of plan) {
    const spent = Date.now() - started;
    // Every candidate after the first has to fit in what is left, judged by
    // how long the last one took; otherwise the caller waits for a result it
    // already has a good enough version of.
    if (best && spent + spent / tried > budgetMs) break;
    const result = arrangeGraph(artifacts, arrows, {
      ...options,
      direction: candidate.direction,
      spacingSteps: [candidate.scale],
      portSearch: { maxTried: trials, ...options.portSearch },
    });
    tried += 1;
    if (!best || result.qualityAfter.score > best.qualityAfter.score) best = result;
  }

  if (!best) return { ok: false, error: 'Раскладка не дала результата' };
  return { ok: true, result: best, tried, planned: plan.length, ms: Date.now() - started };
};

/**
 * Routing for a board whose nodes are already placed.
 *
 * This is `board_route_arrows` word for word — four candidates over two
 * questions, best one wins — moved onto this thread. It is here and not in the
 * tool because together these calls are seconds of CPU on a middling board and
 * a minute on a big one, and the window has to keep drawing while an agent
 * waits for them. The tool applies whatever comes back.
 */
const runRoute = (request: RouteRequest): RouteReply => {
  const started = Date.now();
  const { artifacts, arrows, options } = request;
  const before = boardQuality(artifacts, arrows);

  const withPorts = (list: Arrow[], detour: boolean) =>
    searchPorts(artifacts, list, {
      detour,
      lockedArrowIds: list.filter((arrow) => !arrow.autoPorts).map((arrow) => arrow.id),
      ...(request.portTrials ? { maxTried: request.portTrials } : {}),
    });

  // Re-lay or keep, detour or not: the board as it stands is a candidate too,
  // because a re-route discards the attachments the agent chose and the port
  // search then has to climb out of wherever the fresh routing landed.
  const snapshot = arrows.map((arrow) => ({ ...arrow }));
  const candidates = [withPorts(snapshot, true)];
  if (before.counts.arrowArrow > 0) candidates.push(withPorts(snapshot, false));

  const result = routeArrows(artifacts, arrows, options);
  if (result.refused) {
    return { ok: true, kind: 'route', result, ports: null, portSwaps: 0, refused: true, note: result.note ?? '', ms: Date.now() - started };
  }

  // The routed board, exactly as `applyRoute` would write it: bends rounded,
  // sides and offsets pinned, marked as the router's own.
  const relaid = arrows.map((arrow) => {
    const routed = result.routed.find((item) => item.arrowId === arrow.id);
    if (!routed) return { ...arrow };
    return {
      ...arrow,
      bends: routed.bends.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
      routing: arrow.routing === 'curved' ? arrow.routing : ('orthogonal' as const),
      autoPorts: true,
      from: { ...arrow.from, side: routed.fromSide, offset: clampOffset(routed.fromOffset) },
      to: { ...arrow.to, side: routed.toSide, offset: clampOffset(routed.toOffset) },
    };
  });
  const relaidQuality = boardQuality(artifacts, relaid);
  candidates.push(withPorts(relaid, true));
  if (relaidQuality.counts.arrowArrow > 0) candidates.push(withPorts(relaid, false));

  let winner: (typeof candidates)[number] | null = null;
  let winningCost = relaidQuality.cost;
  for (const candidate of candidates) {
    if (candidate.costAfter >= winningCost) continue;
    winner = candidate;
    winningCost = candidate.costAfter;
  }

  return {
    ok: true,
    kind: 'route',
    result,
    ports: winner ? winner.arrows : null,
    portSwaps: winner?.swaps ?? 0,
    refused: false,
    note: result.note ?? '',
    ms: Date.now() - started,
  };
};

/** Entry point for both jobs; the request says which. */
export const runArrange = (request: ArrangeRequest | RouteRequest): ArrangeReply | ArrangeFailure | RouteReply =>
  request.kind === 'route' ? runRoute(request) : runLayout(request);
