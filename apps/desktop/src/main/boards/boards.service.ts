import type { Arrow, Artifact, Board, BoardState, BoardSummary, StateChange, Viewport } from '@zmtki/shared';
import { applyStateChange, captureState, diffState, emptyBoardState, isEmptyChange } from '@zmtki/shared';
import path from 'node:path';
import { notFound } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { JsonStore } from '../core/store.js';

/**
 * One undoable step: what to apply to go back, and what to apply to go forward
 * again. teca kept a full copy of the board per step; on a 10 000-artifact
 * board that was megabytes per entry, sixty entries deep, rewritten to disk on
 * every save. A step now holds only the entities it touched.
 */
interface HistoryEntry {
  undo: StateChange;
  redo: StateChange;
}

interface BoardRecord {
  board: Board;
  past: HistoryEntry[];
  future: HistoryEntry[];
}

interface BoardsData {
  boards: BoardRecord[];
}

const HISTORY_LIMIT = 60;

export interface CreateBoardInput {
  title?: string;
  description?: string;
  rootDir?: string;
}

/**
 * Who changed the board. The renderer uses it to tell an agent's edit apart
 * from the echo of its own, and the side panel to say which agent acted.
 */
export type ChangeOrigin = 'renderer' | 'agent' | 'host';

export interface BoardMeta {
  title: string;
  description: string;
  rootDir: string;
  updatedAt: number;
}

/**
 * What listeners hear. A delta carries only the entities a transaction touched
 * and the version it produces; a reset carries the whole board and is used
 * where a delta would be as large — creating a board, generating a bench one.
 * A receiver that sees a version gap asks for the board again.
 */
export type BoardEvent =
  | { type: 'board_reset'; board: Board; origin: ChangeOrigin; agentId?: string }
  | {
      type: 'board_delta';
      boardId: string;
      version: number;
      change: StateChange;
      meta: BoardMeta;
      /** Set for undo and redo, so the renderer can animate them as a user action. */
      history?: 'undo' | 'redo';
      origin: ChangeOrigin;
      agentId?: string;
    };

export type BoardListener = (event: BoardEvent) => void;

const NL = String.fromCharCode(10);

const isLegacySnapshot = (entry: unknown): boolean =>
  !!entry && typeof entry === 'object' && 'artifacts' in (entry as Record<string, unknown>);

export class BoardsService {
  private readonly store: JsonStore<BoardsData>;
  private readonly listeners = new Set<BoardListener>();
  /** Who the synchronous part of the current call acts for; see runAs. */
  private actor: { origin: ChangeOrigin; agentId?: string } | null = null;
  /** Last layout cost per board, so the agent can be told whether it improved. */
  private readonly qualityMemo = new Map<string, number>();

  constructor(dataDir: string) {
    this.store = new JsonStore<BoardsData>(path.join(dataDir, 'boards.json'), () => ({
      boards: [],
    }));
    for (const record of this.store.get().boards) {
      // Boards saved before zones and versions existed.
      record.board.state.zones ??= [];
      record.board.rootDir ??= '';
      record.board.version ??= 0;
      // History written by the snapshot-based service cannot be replayed as
      // patches; it is dropped rather than misapplied.
      if (record.past.some(isLegacySnapshot) || record.future.some(isLegacySnapshot)) {
        record.past = [];
        record.future = [];
      }
    }
  }

  onUpdate(listener: BoardListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private resolveOrigin(origin?: ChangeOrigin): { origin: ChangeOrigin; agentId?: string } {
    const resolved = origin ?? this.actor?.origin ?? 'host';
    return { origin: resolved, agentId: resolved === 'agent' ? this.actor?.agentId : undefined };
  }

  private emit(event: BoardEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitReset(board: Board, origin?: ChangeOrigin): void {
    this.emit({ type: 'board_reset', board, ...this.resolveOrigin(origin) });
  }

  private emitDelta(record: BoardRecord, change: StateChange, origin?: ChangeOrigin, history?: 'undo' | 'redo'): void {
    const { board } = record;
    this.emit({
      type: 'board_delta',
      boardId: board.id,
      version: board.version,
      change,
      meta: { title: board.title, description: board.description, rootDir: board.rootDir, updatedAt: board.updatedAt },
      history,
      ...this.resolveOrigin(origin),
    });
  }

  /**
   * Runs a tool call on behalf of an agent, so the mutations it makes are
   * reported as that agent's. The tools were written against `mutate` without
   * an origin and stay that way; the actor is set around the call instead.
   * Board tools mutate synchronously, so the window is exact for them.
   */
  runAs<R>(agentId: string, fn: () => R): R {
    const previous = this.actor;
    this.actor = { origin: 'agent', agentId };
    try {
      return fn();
    } finally {
      this.actor = previous;
    }
  }

  private record(id: string): BoardRecord {
    const record = this.store.get().boards.find((r) => r.board.id === id);
    if (!record) throw notFound(`Board ${id}`);
    return record;
  }

  private summarize(record: BoardRecord): BoardSummary {
    const { board, past, future } = record;
    return {
      id: board.id,
      title: board.title,
      description: board.description,
      rootDir: board.rootDir,
      artifactCount: board.state.artifacts.length,
      arrowCount: board.state.arrows.length,
      zoneCount: board.state.zones.length,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      updatedAt: board.updatedAt,
    };
  }

  list(): BoardSummary[] {
    return this.store.get().boards.map((r) => this.summarize(r));
  }

  listBoards(): Board[] {
    return this.store.get().boards.map((r) => r.board);
  }

  get(id: string): Board {
    return this.record(id).board;
  }

  /** A complete, detached checkpoint of the graph (nodes and arrows together). */
  snapshot(id: string): BoardState {
    return structuredClone(this.record(id).board.state);
  }

  private pushHistory(record: BoardRecord, entry: HistoryEntry): void {
    record.past.push(entry);
    if (record.past.length > HISTORY_LIMIT) record.past.shift();
    record.future = [];
  }

  /**
   * Records a finished transaction: diff against the state captured before it,
   * push the step, bump the version, broadcast the delta. A transaction that
   * changed nothing leaves no history entry and sends nothing.
   */
  private commit(
    record: BoardRecord,
    before: ReturnType<typeof captureState>,
    origin?: ChangeOrigin,
    recordHistory = true,
  ): void {
    const { forward, inverse } = diffState(before, record.board.state);
    if (isEmptyChange(forward)) return;
    if (recordHistory) this.pushHistory(record, { undo: inverse, redo: forward });
    record.board.version += 1;
    record.board.updatedAt = Date.now();
    this.store.update(() => undefined);
    this.emitDelta(record, forward, origin);
  }

  /**
   * Restores a complete checkpoint as one undoable transaction. Partial
   * inverse operations are intentionally avoided: graph consistency is only
   * guaranteed when artifacts and arrows are restored together.
   */
  restoreState(id: string, state: BoardState, origin: ChangeOrigin = 'host'): Board {
    const record = this.record(id);
    const before = captureState(record.board.state);
    record.board.state = structuredClone(state);
    record.board.state.zones ??= [];
    this.commit(record, before, origin);
    return record.board;
  }

  history(id: string): { canUndo: boolean; canRedo: boolean } {
    const record = this.record(id);
    return { canUndo: record.past.length > 0, canRedo: record.future.length > 0 };
  }

  create(input: CreateBoardInput = {}): Board {
    const now = Date.now();
    const count = this.store.get().boards.length;
    const board: Board = {
      id: newId('brd'),
      title: input.title?.trim() || `Доска ${count + 1}`,
      description: input.description ?? '',
      rootDir: input.rootDir ?? '',
      state: emptyBoardState(),
      viewport: { x: 0, y: 0, zoom: 1 },
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.update((data) => {
      data.boards.push({ board, past: [], future: [] });
    });
    this.emitReset(board);
    return board;
  }

  updateMeta(
    id: string,
    patch: { title?: string; description?: string; rootDir?: string; viewport?: Viewport },
  ): Board {
    const record = this.record(id);
    if (patch.title != null) record.board.title = patch.title;
    if (patch.description != null) record.board.description = patch.description;
    if (patch.rootDir != null) record.board.rootDir = patch.rootDir;
    // The viewport is a UI preference, so it is not part of undo history.
    if (patch.viewport) record.board.viewport = patch.viewport;
    record.board.version += 1;
    record.board.updatedAt = Date.now();
    this.store.update(() => undefined);
    this.emitDelta(record, { artifacts: { upsert: [], remove: [] }, arrows: { upsert: [], remove: [] }, zones: { upsert: [], remove: [] } }, 'renderer');
    return record.board;
  }

  /**
   * Saves the camera without broadcasting. It is per-window state, and echoing
   * it back mid-pan would fight the renderer for the camera.
   */
  setViewport(id: string, viewport: Viewport): void {
    const record = this.store.get().boards.find((r) => r.board.id === id);
    if (!record) return;
    record.board.viewport = viewport;
    this.store.update(() => undefined);
  }

  /**
   * A board of `count` artifacts in clusters with a few arrows inside each —
   * shaped like a real research board rather than a uniform grid, so culling
   * is measured against uneven density. Written in one go and outside history:
   * a benchmark board is not something to undo into.
   */
  createBench(count: number): Board {
    const board = this.create({ title: 'Бенч: ' + count + ' артефактов' });
    const now = Date.now();
    const types = ['note', 'markdown', 'code', 'shape', 'text', 'file'] as const;
    const perCluster = 24;
    const side = Math.ceil(Math.sqrt(Math.ceil(count / perCluster)));
    const artifacts: Artifact[] = [];
    const arrows: Arrow[] = [];
    for (let i = 0; i < count; i += 1) {
      const cluster = Math.floor(i / perCluster);
      const local = i % perCluster;
      const type = types[i % types.length];
      const id = newId('art');
      const text =
        '### Узел ' + i + NL + NL + 'Кластер ' + cluster + ', элемент ' + local + '.' + NL + NL +
        '- первый пункт' + NL + '- второй пункт';
      const props =
        type === 'code'
          ? { language: 'ts', code: 'export function node' + i + '() {' + NL + '  return ' + i + ';' + NL + '}', title: 'node' + i + '.ts' }
          : type === 'shape'
            ? { shape: 'rect', fill: '#1f2430', stroke: '#5b6478', label: 'Блок ' + i }
            : type === 'file'
              ? { path: 'src/module-' + i + '.ts' }
              : type === 'text'
                ? { text: 'Раздел ' + cluster, fontSize: 24, weight: 600, align: 'left', color: '#e8e8ea' }
                : { text, color: 'yellow' };
      artifacts.push({
        id,
        type,
        x: (cluster % side) * 2400 + (local % 6) * 320,
        y: Math.floor(cluster / side) * 1900 + Math.floor(local / 6) * 300,
        width: 260,
        height: type === 'text' ? 64 : 220,
        z: i + 1,
        props,
        createdAt: now,
        updatedAt: now,
      });
      if (local > 0 && local % 6 !== 0) {
        arrows.push({
          id: newId('arr'),
          from: { artifactId: artifacts[i - 1].id, side: 'auto' },
          to: { artifactId: id, side: 'auto' },
          bends: [],
          routing: 'orthogonal',
          style: {},
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    const record = this.record(board.id);
    record.board.state.artifacts = artifacts;
    record.board.state.arrows = arrows;
    record.board.version += 1;
    record.board.updatedAt = now;
    this.store.update(() => undefined);
    this.emitReset(record.board, 'host');
    return record.board;
  }

  remove(id: string): void {
    this.store.update((data) => {
      const index = data.boards.findIndex((r) => r.board.id === id);
      if (index < 0) throw notFound(`Board ${id}`);
      data.boards.splice(index, 1);
    });
  }

  /**
   * Applies a mutation as one undoable transaction. Every agent tool call and
   * every finished user gesture goes through here.
   *
   * The state is captured shallowly before the mutator runs (see `captureState`);
   * a failed mutator is rolled back by applying the captured entities over the
   * partial writes, so a failed tool call still never corrupts a board.
   */
  mutate<R>(
    id: string,
    mutator: (state: BoardState, board: Board) => R,
    origin?: ChangeOrigin,
  ): R {
    const record = this.record(id);
    const before = captureState(record.board.state);
    let result: R;
    try {
      result = mutator(record.board.state, record.board);
    } catch (error) {
      const { inverse } = diffState(before, record.board.state);
      record.board.state = applyStateChange(record.board.state, inverse, true);
      throw error;
    }
    this.commit(record, before, origin ?? (this.actor ? undefined : 'renderer'));
    return result;
  }

  /**
   * A change that is state the app observed rather than an edit anyone made —
   * the page a browser card navigated to, a file's size. Broadcast like any
   * change, but kept out of undo: Ctrl+Z must not send the browser back.
   */
  observe(id: string, mutator: (state: BoardState) => void): void {
    const record = this.store.get().boards.find((r) => r.board.id === id);
    if (!record) return;
    const before = captureState(record.board.state);
    mutator(record.board.state);
    this.commit(record, before, 'host', false);
  }

  /** Read-only access without touching history. */
  read<R>(id: string, reader: (state: BoardState, board: Board) => R): R {
    const record = this.record(id);
    return reader(record.board.state, record.board);
  }

  previousQuality(id: string): number | null {
    return this.qualityMemo.get(id) ?? null;
  }

  rememberQuality(id: string, cost: number): void {
    this.qualityMemo.set(id, cost);
  }

  private step(id: string, direction: 'undo' | 'redo'): Board {
    const record = this.record(id);
    const entry = direction === 'undo' ? record.past.pop() : record.future.pop();
    if (!entry) return record.board;
    const change = direction === 'undo' ? entry.undo : entry.redo;
    // Copies go into the live state: the entry must survive later in-place
    // writes to be applied again by the opposite step.
    record.board.state = applyStateChange(record.board.state, change, true);
    (direction === 'undo' ? record.future : record.past).push(entry);
    record.board.version += 1;
    record.board.updatedAt = Date.now();
    this.store.update(() => undefined);
    this.emitDelta(record, change, 'renderer', direction);
    return record.board;
  }

  undo(id: string): Board {
    return this.step(id, 'undo');
  }

  redo(id: string): Board {
    return this.step(id, 'redo');
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
