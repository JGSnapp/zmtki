/**
 * Port assignment search.
 *
 * The router lays each arrow on its own, so which side and which point of a
 * node an arrow attaches to is decided once and never revisited. On the bench
 * boards two thirds of the remaining crossings were between arrows meeting at
 * the same node — the shape you get when three lines arrive in the order
 * 1-2-3 where 2-1-3 would not cross.
 *
 * Pricing does not fix that: raising the cost of a crossing twenty-five-fold
 * left the count unchanged, because the router has no way to *express* a
 * different attachment. This searches over the attachments themselves: swap the
 * ports of two arrows meeting at one node, re-lay them, keep the swap when the
 * board scores better. Repeat until nothing improves.
 */
import type { Arrow, Artifact, Vec2 } from './artifacts.js';
import {
  CORNER_INSET,
  FIXED_SIDES,
  type ArrowGeometry,
  computeArrowGeometries,
  insetOffset,
  type FixedSide,
} from './geometry.js';
import { checkIntersections } from './intersections.js';
import { boardQuality } from './quality.js';
import { routeArrows, tooTightToRoute } from './routing.js';

interface End {
  arrowId: string;
  end: 'from' | 'to';
  side: FixedSide;
  offset: number;
}

export interface PortSearchOptions {
  /** Give up after this many accepted moves of any kind. */
  maxSwaps?: number;
  /**
   * Work budget: candidates evaluated before the search stops, accepted or
   * not. Each candidate costs one short routing call, so without this a dense
   * board with three move types per end takes minutes.
   */
  maxTried?: number;
  /** Sweeps over every node before stopping. */
  passes?: number;
  /** Arrows whose ports the caller pinned deliberately; never touched. */
  lockedArrowIds?: string[];
  /**
   * Lay every side out evenly at the end, instead of leaving the ports where
   * the search stopped. On by default: an even side is what makes a fan of
   * children read as deliberate. Switch off to see what the search alone does.
   */
  evenSpacing?: boolean;
  /**
   * Release both ports of an arrow that is in a crossing and try every pair of
   * sides afresh. Two changes at once, which is the only way out of the local
   * minimum where each change alone makes the board worse. On by default;
   * switch off to see what the one-at-a-time moves reach on their own.
   */
  detour?: boolean;
  /**
   * Draws the given arrows for the current attachment. Defaults to our own
   * router; a caller can plug in another one — the search cares only that the
   * polyline matches the ports it just set.
   */
  relay?: (artifacts: Artifact[], arrows: Arrow[], arrowIds: string[]) => Arrow[] | null;
}

export interface PortSearchResult {
  arrows: Arrow[];
  /** Accepted swaps between two arrows meeting at one node. */
  swaps: number;
  /** Accepted moves of one end to another side of its node. */
  moves: number;
  /** Accepted nudges of one end along the side it already sits on. */
  nudges: number;
  costBefore: number;
  costAfter: number;
  /** Swaps that were tried and rejected, for the report. */
  tried: number;
}

/**
 * The ends sitting on one artifact, with `auto` resolved rather than skipped.
 *
 * An end whose stored side is `auto` is still drawn somewhere concrete — the
 * renderer works the side out from the geometry — but skipping it here made it
 * invisible to the whole search: it could not be nudged, moved or swapped with
 * anything. On one board that hid exactly the swap that was needed, because one
 * of the two lines had never been given a side and the search only ever saw its
 * neighbour. Resolving through the drawn geometry puts them back in play.
 */
const endsAt = (
  arrows: Arrow[],
  artifactId: string,
  locked: Set<string>,
  geometries: Map<string, ArrowGeometry>,
): End[] => {
  const out: End[] = [];
  for (const arrow of arrows) {
    if (locked.has(arrow.id)) continue;
    const geometry = geometries.get(arrow.id);
    if (arrow.from.artifactId === artifactId) {
      const side = arrow.from.side === 'auto' ? geometry?.fromSide : arrow.from.side;
      if (side) {
        out.push({
          arrowId: arrow.id,
          end: 'from',
          side,
          offset: arrow.from.offset ?? geometry?.fromOffset ?? 0.5,
        });
      }
    }
    if (arrow.to.artifactId === artifactId) {
      const side = arrow.to.side === 'auto' ? geometry?.toSide : arrow.to.side;
      if (side) {
        out.push({
          arrowId: arrow.id,
          end: 'to',
          side,
          offset: arrow.to.offset ?? geometry?.toOffset ?? 0.5,
        });
      }
    }
  }
  return out;
};

/** Candidate points along a side, from the middle outwards. */
const OFFSETS = [0.5, 0.28, 0.72, 0.14, 0.86];

/**
 * The candidates for one concrete side, with the corner zone taken out.
 *
 * The bare table is in proportions, and 0.14 of an 80px side is 11px from the
 * corner — so the search used to propose the very ports the corner rule exists
 * to avoid. Insetting collapses some candidates onto each other on short
 * sides; the duplicates are dropped rather than tried twice.
 */
const offsetsFor = (artifact: Artifact, side: FixedSide): number[] => {
  const out: number[] = [];
  const add = (offset: number) => {
    if (!out.some((seen) => Math.abs(seen - offset) < 0.02)) out.push(offset);
  };
  for (const offset of OFFSETS) add(insetOffset(artifact, side, offset));
  // The corner zone stays reachable, after the inset candidates.
  //
  // Keeping the corner clear is worth a lot, but not worth bending a line that
  // was running straight: on a tree whose children sit under the edge of their
  // parent, insetting the port turned four straight arrows into dog-legs and
  // cost fourteen points. The search takes only strict improvements, so a port
  // comes back to the corner exactly when it straightens something and never
  // merely because it can.
  for (const offset of OFFSETS) add(offset);
  return out;
};

/**
 * The offset that would put this end level with the port it faces — the one
 * value that turns the arrow into a straight line.
 *
 * The candidate table is written in proportions and fixed, so the offset that
 * happens to line up with a particular partner is almost never in it. Without
 * this the search cannot straighten a line by moving one end, however obvious
 * that move looks: it can only try 0.5, 0.28, 0.72, 0.14 and 0.86 and hope.
 *
 * Returns null when the two ends do not face each other along one axis, since
 * then no single slide can make the line straight.
 */
const alignedOffset = (
  artifact: Artifact,
  side: FixedSide,
  partner: Vec2,
): number | null => {
  const horizontal = side === 'top' || side === 'bottom';
  const span = horizontal ? artifact.width : artifact.height;
  const start = horizontal ? artifact.x : artifact.y;
  const target = horizontal ? partner.x : partner.y;
  const offset = (target - start) / Math.max(span, 1);
  if (offset < 0 || offset > 1) return null;
  return offset;
};

/**
 * The far end of each named arrow, slid to line up with its own near end.
 *
 * A swap on its own often does not pay: moving two lines to each other's ports
 * fixes which one is on the left, but leaves each with a step at the other end,
 * and the step costs about what the removed crossing saved. The pay-off only
 * appears after the second move — and a search that takes strictly improving
 * single steps can never see it, because the first step alone is not an
 * improvement. So the two are offered together.
 */
const straightened = (
  artifacts: Artifact[],
  arrows: Arrow[],
  arrowIds: string[],
): Arrow[] => {
  const boxes = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const geometries = computeArrowGeometries(artifacts, arrows);
  return arrows.map((arrow) => {
    if (!arrowIds.includes(arrow.id)) return arrow;
    const geometry = geometries.get(arrow.id);
    if (!geometry) return arrow;
    const to = boxes.get(arrow.to.artifactId);
    if (!to) return arrow;
    const horizontal = geometry.toSide === 'top' || geometry.toSide === 'bottom';
    // Only when both ends leave along the same axis can one slide make the
    // line straight.
    const sameAxis =
      horizontal === (geometry.fromSide === 'top' || geometry.fromSide === 'bottom');
    if (!sameAxis) return arrow;
    const span = horizontal ? to.width : to.height;
    const start = horizontal ? to.x : to.y;
    const target = horizontal ? geometry.fromPoint.x : geometry.fromPoint.y;
    const offset = insetOffset(to, geometry.toSide, (target - start) / Math.max(span, 1));
    if (Math.abs(offset - geometry.toOffset) < 0.01) return arrow;
    return { ...arrow, bends: [], autoPorts: false, to: { ...arrow.to, offset } };
  });
};

/** Slides both ends of one arrow at once, keeping whatever they share. */
const withBothOffsets = (arrows: Arrow[], arrowId: string, from: number, to: number): Arrow[] =>
  arrows.map((arrow) =>
    arrow.id === arrowId
      ? {
          ...arrow,
          bends: [],
          from: { ...arrow.from, offset: from },
          to: { ...arrow.to, offset: to },
        }
      : arrow,
  );

/**
 * Slides one end along the side it already sits on.
 *
 * `autoPorts` has to come off. It marks a port the router owns, and
 * `routeArrows` releases every such port before laying the arrow again — so a
 * nudge left under that flag is thrown away and replaced by whatever the router
 * prefers. Measured before this line existed: 0 of 77 nudges survived the
 * relay, which made the whole move type inert.
 */
const withNudgedOffset = (arrows: Arrow[], end: End, offset: number): Arrow[] =>
  arrows.map((arrow) => {
    if (arrow.id !== end.arrowId) return arrow;
    const patched = { ...arrow, bends: [], autoPorts: false };
    const endpoint = end.end === 'from' ? { ...patched.from } : { ...patched.to };
    endpoint.offset = offset;
    if (end.end === 'from') patched.from = endpoint;
    else patched.to = endpoint;
    return patched;
  });

/** Moves one end to another side, letting the distribution pick the point. */
const withMovedSide = (arrows: Arrow[], end: End, side: FixedSide): Arrow[] =>
  arrows.map((arrow) => {
    if (arrow.id !== end.arrowId) return arrow;
    const patched = { ...arrow, bends: [] };
    const endpoint = end.end === 'from' ? { ...patched.from } : { ...patched.to };
    endpoint.side = side;
    // Released, so the port lands where the spread puts it on the new side.
    endpoint.offset = undefined;
    if (end.end === 'from') patched.from = endpoint;
    else patched.to = endpoint;
    return patched;
  });

/**
 * Both ends belong to the same artifact, but not to the same side — and an
 * offset is a share of the side it was measured on. Handing 0.08 of a 220px
 * width to an 80px height puts the port 6px from the corner, so each offset is
 * re-inset against the side it is arriving on.
 */
const withSwappedPorts = (arrows: Arrow[], artifact: Artifact, a: End, b: End): Arrow[] =>
  arrows.map((arrow) => {
    if (arrow.id === a.arrowId) {
      // Same reason as the nudge: a swapped port only holds if the router stops
      // treating it as its own.
      const patched = { ...arrow, autoPorts: false };
      const endpoint = a.end === 'from' ? { ...patched.from } : { ...patched.to };
      endpoint.side = b.side;
      endpoint.offset = insetOffset(artifact, b.side, b.offset);
      if (a.end === 'from') patched.from = endpoint;
      else patched.to = endpoint;
      // The stored polyline was built for the old attachment.
      patched.bends = [];
      return patched;
    }
    if (arrow.id === b.arrowId) {
      const patched = { ...arrow, autoPorts: false };
      const endpoint = b.end === 'from' ? { ...patched.from } : { ...patched.to };
      endpoint.side = a.side;
      endpoint.offset = insetOffset(artifact, a.side, a.offset);
      if (b.end === 'from') patched.from = endpoint;
      else patched.to = endpoint;
      patched.bends = [];
      return patched;
    }
    return arrow;
  });

const relayWith =
  (spreadPorts: boolean) =>
  (artifacts: Artifact[], arrows: Arrow[], arrowIds: string[]): Arrow[] | null => {
    if (!tooTightToRoute(artifacts, arrows, arrowIds).ready) return null;
    const outcome = routeArrows(artifacts, arrows, { arrowIds, spreadPorts });
    if (outcome.refused) return null;
    return arrows.map((arrow) => {
      const routed = outcome.routed.find((item) => item.arrowId === arrow.id);
      if (!routed) return arrow;
      return {
        ...arrow,
        bends: routed.bends,
        routing: 'orthogonal' as const,
        from: { ...arrow.from, side: routed.fromSide, offset: routed.fromOffset },
        to: { ...arrow.to, side: routed.toSide, offset: routed.toOffset },
      };
    });
  };

const defaultRelay = relayWith(false);
/** Same router, told to give the arrow a port of its own. */
const spreadRelay = relayWith(true);

/**
 * Hill climbing over port swaps. Only two arrows are re-laid per candidate, so
 * a rejected swap costs one short routing call rather than a full re-route.
 */
export const searchPorts = (
  artifacts: Artifact[],
  arrows: Arrow[],
  options: PortSearchOptions = {},
): PortSearchResult => {
  // Measured on 89 boards: at the old budget of 400/24/2 the search ran out
  // before it finished on 12 of them, and stopping early cost real quality —
  // raising the ceiling fourfold took the mean penalty from 18.5 to 16.9 and
  // the crossings from 298 to 263, for about 40% more time. Nothing above this
  // buys anything: 20000/600/8 gives byte-identical results.
  const maxSwaps = options.maxSwaps ?? 96;
  const maxTried = options.maxTried ?? 1600;
  const passes = options.passes ?? 4;
  const locked = new Set(options.lockedArrowIds ?? []);
  const relay = options.relay ?? defaultRelay;
  // The detour tries the same sides twice: once letting the arrow take whatever
  // port the router likes, once insisting it gets one of its own. A caller with
  // its own router only gets the first — we cannot ask it for the second.
  const detourRelays = options.relay ? [relay] : [relay, spreadRelay];

  const costBefore = boardQuality(artifacts, arrows).cost;
  let current = arrows;
  let currentCost = costBefore;
  let swaps = 0;
  let moves = 0;
  let nudges = 0;
  let tried = 0;

  for (let pass = 0; pass < passes && swaps + moves + nudges < maxSwaps && tried < maxTried; pass++) {
    let improvedThisPass = false;

    for (const artifact of artifacts) {
      if (swaps + moves + nudges >= maxSwaps || tried >= maxTried) break;
      const ends = endsAt(current, artifact.id, locked, computeArrowGeometries(artifacts, current));
      if (ends.length === 0) continue;

      // Third move type: slide one end along the side it is already on. A swap
      // needs a partner and a side move changes the direction the line leaves
      // in; sliding is the smallest correction there is, and it is the one that
      // straightens a line that had to bend around its own neighbour.
      const facing = computeArrowGeometries(artifacts, current);
      for (const end of ends) {
        if (swaps + moves + nudges >= maxSwaps || tried >= maxTried) break;
        const geometry = facing.get(end.arrowId);
        const partner = geometry
          ? end.end === 'from'
            ? geometry.toPoint
            : geometry.fromPoint
          : null;
        const aligned = partner ? alignedOffset(artifact, end.side, partner) : null;
        const candidates =
          aligned == null
            ? offsetsFor(artifact, end.side)
            : // Tried first: if the line can be made straight by moving this one
              // end, nothing further down the table will beat it.
              [aligned, ...offsetsFor(artifact, end.side)];
        for (const offset of candidates) {
          if (Math.abs(offset - end.offset) < 0.02) continue;
          tried += 1;
          const nudged = withNudgedOffset(current, end, offset);
          const relaid = relay(artifacts, nudged, [end.arrowId]);
          if (!relaid) continue;
          const cost = boardQuality(artifacts, relaid).cost;
          if (cost < currentCost - 1e-6) {
            current = relaid;
            currentCost = cost;
            nudges += 1;
            improvedThisPass = true;
            break;
          }
        }
      }

      // Second move type: send one end to another side of the same node. A
      // swap can only reshuffle the sides already in use, so a node whose
      // arrows all arrive on one side has nothing to trade.
      for (const end of ends) {
        if (swaps + moves + nudges >= maxSwaps || tried >= maxTried) break;
        for (const side of FIXED_SIDES) {
          if (side === end.side) continue;
          tried += 1;
          const movedArrows = withMovedSide(current, end, side);
          const relaid = relay(artifacts, movedArrows, [end.arrowId]);
          if (!relaid) continue;
          const cost = boardQuality(artifacts, relaid).cost;
          if (cost < currentCost - 1e-6) {
            current = relaid;
            currentCost = cost;
            moves += 1;
            improvedThisPass = true;
            break;
          }
        }
      }

      for (let i = 0; i < ends.length && swaps + moves + nudges < maxSwaps && tried < maxTried; i++) {
        for (let j = i + 1; j < ends.length; j++) {
          const a = ends[i];
          const b = ends[j];
          if (a.arrowId === b.arrowId) continue;
          if (a.side === b.side && Math.abs(a.offset - b.offset) < 1e-6) continue;

          tried += 1;
          const ids = [a.arrowId, b.arrowId];
          const swapped = withSwappedPorts(current, artifact, a, b);
          let relaid = relay(artifacts, swapped, ids);
          if (!relaid) continue;

          let cost = boardQuality(artifacts, relaid).cost;
          // The swap plus the follow-up slide, judged as one move.
          const tidied = relay(artifacts, straightened(artifacts, relaid, ids), ids);
          if (tidied) {
            const tidyCost = boardQuality(artifacts, tidied).cost;
            if (tidyCost < cost) {
              relaid = tidied;
              cost = tidyCost;
            }
          }
          // A swap has to pay for itself: equal cost keeps the original, so the
          // search cannot wander sideways forever.
          if (cost < currentCost - 1e-6) {
            current = relaid;
            currentCost = cost;
            swaps += 1;
            improvedThisPass = true;
            break;
          }
        }
      }
    }

    // Fourth move type: the detour.
    //
    // The three above change one thing at a time and keep the change only if
    // the board improves right away. That cannot reach a route a person draws
    // without thinking: "move the arrow left and take it round the bottom" is
    // two changes, and on a real board each one *alone* makes things worse.
    // Measured on `fix-broken`: sending the far end to the bottom side scores
    // 83 against 86, so the side pass refuses it — yet the same side move with
    // the near end also slid over scores 96, better than anything else on that
    // board and better than the route drawn by hand.
    //
    // So for an arrow that is actually in a crossing, release both of its ports
    // at once — sides and offsets — and let the router lay it afresh against
    // each pair of sides, twice: once taking whatever port it likes, once made
    // to take one of its own. Thirty-two short routing calls per tangled arrow,
    // and only for arrows that cross something — an untangled board pays
    // nothing, and a seven-node board costs a fifth of a second.
    const tangled =
      options.detour === false ? [] : checkIntersections(artifacts, current).findings;
    const crossing = new Set<string>();
    for (const finding of tangled) {
      if (finding.kind !== 'arrow_arrow') continue;
      crossing.add(finding.arrowAId);
      crossing.add(finding.arrowBId);
    }
    for (const arrowId of crossing) {
      if (locked.has(arrowId)) continue;
      if (swaps + moves + nudges >= maxSwaps || tried >= maxTried) break;
      for (const fromSide of FIXED_SIDES) {
        for (const toSide of FIXED_SIDES) {
          for (const lay of detourRelays) {
            tried += 1;
            const freed = current.map((arrow) =>
              arrow.id === arrowId
                ? {
                    ...arrow,
                    bends: [],
                    // Sides held, offsets left open: the router may choose
                    // where on each side the line attaches, which is the half
                    // of the move the search cannot see on its own.
                    autoPorts: false,
                    from: { ...arrow.from, side: fromSide, offset: undefined },
                    to: { ...arrow.to, side: toSide, offset: undefined },
                  }
                : arrow,
            );
            if (!tooTightToRoute(artifacts, freed, [arrowId]).ready) continue;
            const relaid = lay(artifacts, freed, [arrowId]);
            if (!relaid) continue;
            const cost = boardQuality(artifacts, relaid).cost;
            if (cost < currentCost - 1e-6) {
              current = relaid;
              currentCost = cost;
              moves += 1;
              improvedThisPass = true;
            }
          }
        }
      }
    }

    // Tidying runs inside the pass, not after it.
    //
    // These two put ports where they belong rather than where the climb
    // stopped, and doing so changes which swaps are worth making: on one
    // board the tidied layout made a swap worth four points that had been
    // worth nothing before. Run afterwards they were invisible to the swap
    // loop, which had already finished for good.
  // Ports that hug an edge, without giving up the straight line that put them
  // there.
  //
  // Nine out of ten ports still sitting within `CORNER_INSET` of a corner are
  // there because their arrow runs straight: both ends share one x (or one y),
  // and when the two boxes are offset from each other that shared lane has to
  // run close to the edge of one of them. Moving a single end would bend the
  // line, which is why the search above refuses — a bend costs more than a
  // clear corner. Moving *both* ends by the same distance keeps the line
  // perfectly straight and can clear both corners at once.
  //
  // An earlier version of this pass moved one end and accepted only free moves.
  // It never found a single one in 1816 ports, which is what pointed at the
  // shared lane as the thing to move.
  const boxes = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const geometry of computeArrowGeometries(artifacts, current).values()) {
    if (locked.has(geometry.arrowId)) continue;
    const arrow = current.find((item) => item.id === geometry.arrowId);
    if (!arrow) continue;
    const from = boxes.get(arrow.from.artifactId);
    const to = boxes.get(arrow.to.artifactId);
    if (!from || !to) continue;

    // Both ends on the same axis is enough; they need not already be level.
    //
    // The router used to slide given ports onto a shared lane by itself, which
    // is how a near-facing pair came out straight. It no longer may — a port
    // somebody chose is an instruction now — so the job moves here, where it is
    // checked against the board instead of applied blindly. The pass therefore
    // handles two cases at once: a straight line whose lane grazes an edge, and
    // a pair that could be straight and is not.
    const vertical =
      (geometry.fromSide === 'top' || geometry.fromSide === 'bottom') &&
      (geometry.toSide === 'top' || geometry.toSide === 'bottom');
    const horizontal =
      (geometry.fromSide === 'left' || geometry.fromSide === 'right') &&
      (geometry.toSide === 'left' || geometry.toSide === 'right');
    if (!vertical && !horizontal) continue;

    const fromSpan = vertical ? from.width : from.height;
    const toSpan = vertical ? to.width : to.height;
    const fromStart = vertical ? from.x : from.y;
    const toStart = vertical ? to.x : to.y;
    const lane = vertical ? geometry.fromPoint.x : geometry.fromPoint.y;

    // Neither box may take more than a third of its side as margin, or a short
    // side would have no lane left at all.
    const room = (span: number) => Math.min(CORNER_INSET, span / 3);
    const low = Math.max(fromStart + room(fromSpan), toStart + room(toSpan));
    const high = Math.min(fromStart + fromSpan - room(fromSpan), toStart + toSpan - room(toSpan));
    if (low > high) continue;

    // Aim at the middle of what both boxes can reach; that is the lane which
    // clears both corners and, for a pair that was not level, the one that
    // makes the line straight.
    const other = vertical ? geometry.toPoint.x : geometry.toPoint.y;
    const wanted = Math.min(high, Math.max(low, Math.round((lane + other) / 2)));
    if (Math.abs(wanted - lane) < 1 && Math.abs(wanted - other) < 1) continue;

    const moved = withBothOffsets(
      current,
      arrow.id,
      (wanted - fromStart) / Math.max(fromSpan, 1),
      (wanted - toStart) / Math.max(toSpan, 1),
    );
    // Deliberately not routed. `relay` re-derives the ports from the path it
    // finds and would overwrite the two offsets this pass just chose — which is
    // why the first attempt appeared to do nothing at all. The arrow stays
    // straight between the two new ports, so there is no path to look for.
    tried += 1;
    const cost = boardQuality(artifacts, moved).cost;
    if (cost <= currentCost + 1e-6) {
      current = moved;
      currentCost = cost;
      nudges += 1;
      improvedThisPass = true;
    }
  }

  // Even spacing along each side.
  //
  // The search above moves one port at a time and takes any move that does not
  // make the board worse, so it leaves a side ragged: three arrows on one edge
  // end up at whatever three offsets the walk happened to stop at. Nothing in
  // the metric can see unevenness, so nothing pulls them level — and a fan of
  // children that used to read as symmetric comes out staggered.
  //
  // This pass lays each side out evenly inside the inset band. It keeps the
  // order the search arrived at, so no line changes which side of another it
  // passes on, and it keeps the result only if the board does not get worse for
  // it — alignment that was worth a straight line stays put.
  for (const artifact of options.evenSpacing === false ? [] : artifacts) {
    for (const side of FIXED_SIDES) {
      const ends = endsAt(
        current,
        artifact.id,
        locked,
        computeArrowGeometries(artifacts, current),
      ).filter((end) => end.side === side);
      if (ends.length === 0) continue;
      ends.sort((a, b) => a.offset - b.offset);

      const low = insetOffset(artifact, side, 0);
      const high = insetOffset(artifact, side, 1);
      let next = current;
      let changed = false;
      ends.forEach((end, slot) => {
        const target = low + (high - low) * ((slot + 1) / (ends.length + 1));
        if (Math.abs(target - end.offset) < 0.01) return;
        changed = true;
        next = next.map((arrow) => {
          if (arrow.id !== end.arrowId) return arrow;
          const patched = { ...arrow, bends: [], autoPorts: false };
          const endpoint = end.end === 'from' ? { ...patched.from } : { ...patched.to };
          endpoint.offset = target;
          if (end.end === 'from') patched.from = endpoint;
          else patched.to = endpoint;
          return patched;
        });
      });
      if (!changed) continue;

      const relaid = relay(artifacts, next, ends.map((end) => end.arrowId));
      if (!relaid) continue;
      tried += 1;
      const cost = boardQuality(artifacts, relaid).cost;
      if (cost <= currentCost + 1e-6) {
        current = relaid;
        currentCost = cost;
        nudges += 1;
        improvedThisPass = true;
      }
    }
  }

    if (!improvedThisPass) break;
  }

  // The pins come out at the end.
  //
  // While the search runs, a port it chose has to hold: the router is free to
  // overrule any port it owns, and until it was made to respect these the whole
  // search was measuring the router's choices as if they were its own. But
  // leaving every arrow pinned afterwards is the opposite mistake — the board
  // then cannot be re-routed at all, and a side the search picked badly is
  // frozen into it. Measured: permanent pinning took wiki-anime from 86 to 79
  // by dragging one line across the top of the drawing, because the router was
  // no longer allowed to correct the choice.
  //
  // So arrows go back to being router-owned. The polyline the search settled on
  // is already written into `bends`; releasing the flag only means a later
  // re-route may improve on it.
  const released = current.map((arrow, index) =>
    arrow.autoPorts === false && arrows[index]?.autoPorts === true
      ? { ...arrow, autoPorts: true }
      : arrow,
  );

  return { arrows: released, swaps, moves, nudges, tried, costBefore, costAfter: currentCost };
};
