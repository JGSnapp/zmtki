import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import {
  BOARD_DIR,
  BOARD_FILE_NAME,
  BoardDocSchema,
  BoardEdgeSchema,
  BoardNodeSchema,
  CameraSchema,
  DEFAULT_LAYER_ID,
  createEmptyBoard,
  findFreeSlot,
  isAgentFrame,
  parseBoard,
  rectOf,
  renderBoardOutline,
  serializeBoard,
  type BoardDoc,
  type BoardEdge,
  type BoardNode,
  type Camera,
  type FrameNode,
  type Layer,
  type NamedView,
  type PayloadRef
} from '@zmtki/board-schema';
import type { BoardOp, BoardTransaction } from '@zmtki/protocol';
import { Emitter } from '../util/emitter.js';
import { debounceWithMaxWait } from '../util/async.js';
import { ensureDir, hashContent, readFileIfExists, writeFileAtomic } from '../util/fs.js';

export interface BoardOpsEvent {
  ops: BoardOp[];
  origin: string | null;
}

const HUMAN_ORIGIN = 'human';

/**
 * Owns one board folder. Lives in the main process so agents keep writing when
 * the window is closed or another project is on screen.
 *
 * Yjs is not here for network multiplayer. It buys two things we need today:
 * an UndoManager scoped by origin, so the user's Ctrl+Z never rewinds an
 * agent's work, and fine-grained change events to drive persistence.
 */
export class BoardStore {
  readonly onOps = new Emitter<BoardOpsEvent>();
  readonly onExternalChange = new Emitter<BoardDoc>();

  private readonly ydoc = new Y.Doc();
  private readonly ynodes: Y.Map<BoardNode>;
  private readonly yedges: Y.Map<BoardEdge>;
  private readonly ymeta: Y.Map<unknown>;
  private readonly undoManager: Y.UndoManager;
  private readonly persist: ReturnType<typeof debounceWithMaxWait>;

  private watcher: FSWatcher | null = null;
  private lastWrittenHash = '';
  private closed = false;
  private suppressWatch = false;

  private constructor(
    readonly dir: string,
    initial: BoardDoc
  ) {
    this.ynodes = this.ydoc.getMap<BoardNode>('nodes');
    this.yedges = this.ydoc.getMap<BoardEdge>('edges');
    this.ymeta = this.ydoc.getMap<unknown>('meta');

    this.loadIntoYDoc(initial);

    // Only the human's edits enter the undo stack. An agent rewinding its own
    // work on a user's keystroke would be worse than no undo at all.
    this.undoManager = new Y.UndoManager([this.ynodes, this.yedges, this.ymeta], {
      trackedOrigins: new Set([HUMAN_ORIGIN]),
      captureTimeout: 400
    });

    this.persist = debounceWithMaxWait(() => this.writeToDisk(), 400, 2500);
    this.ydoc.on('update', () => {
      if (!this.closed) this.persist.schedule();
    });
  }

  static async open(dir: string): Promise<BoardStore> {
    const file = path.join(dir, BOARD_FILE_NAME);
    const text = await readFileIfExists(file);
    let doc: BoardDoc;
    if (text === undefined) {
      doc = createEmptyBoard(path.basename(dir));
    } else {
      const parsed = parseBoard(text);
      if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
      doc = parsed.doc;
    }
    const store = new BoardStore(dir, doc);
    await store.writeToDisk();
    store.startWatching();
    return store;
  }

  static async create(dir: string, name: string): Promise<BoardStore> {
    await ensureDir(dir);
    await ensureDir(path.join(dir, BOARD_DIR));
    const file = path.join(dir, BOARD_FILE_NAME);
    const existing = await readFileIfExists(file);
    if (existing === undefined) {
      await writeFileAtomic(file, serializeBoard(createEmptyBoard(name)));
    }
    return BoardStore.open(dir);
  }

  get id(): string {
    return String(this.ymeta.get('id'));
  }

  get name(): string {
    return String(this.ymeta.get('name') ?? path.basename(this.dir));
  }

  get boardDir(): string {
    return path.join(this.dir, BOARD_DIR);
  }

  private loadIntoYDoc(doc: BoardDoc): void {
    this.ydoc.transact(() => {
      this.ynodes.clear();
      this.yedges.clear();
      for (const node of doc.nodes) this.ynodes.set(node.id, node);
      for (const edge of doc.edges) this.yedges.set(edge.id, edge);
      this.ymeta.set('id', doc.id);
      this.ymeta.set('name', doc.name);
      this.ymeta.set('description', doc.description);
      this.ymeta.set('createdAt', doc.createdAt);
      this.ymeta.set('camera', doc.camera);
      this.ymeta.set('layers', doc.layers);
      this.ymeta.set('views', doc.views);
      this.ymeta.set('settings', doc.settings);
    }, 'load');
  }

  /** Reconstructs a plain, validated document. */
  toDoc(): BoardDoc {
    const layers = (this.ymeta.get('layers') as Layer[] | undefined) ?? [
      { id: DEFAULT_LAYER_ID, name: 'Основной', visible: true, locked: false, order: 0 }
    ];
    return BoardDocSchema.parse({
      version: 1,
      id: this.ymeta.get('id'),
      name: this.ymeta.get('name'),
      description: this.ymeta.get('description') ?? '',
      createdAt: this.ymeta.get('createdAt') ?? Date.now(),
      updatedAt: Date.now(),
      camera: this.ymeta.get('camera') ?? { x: 0, y: 0, zoom: 1 },
      layers,
      nodes: [...this.ynodes.values()],
      edges: [...this.yedges.values()],
      views: (this.ymeta.get('views') as NamedView[] | undefined) ?? [],
      settings: this.ymeta.get('settings') ?? {}
    });
  }

  getNode(id: string): BoardNode | undefined {
    return this.ynodes.get(id);
  }

  /**
   * Packs loose nodes into a grid without touching anything inside a frame.
   * Frame contents belong to an agent, and rearranging them behind its back
   * would change what it sees in its next turn.
   */
  tidy(): number {
    const frames = this.nodes.filter((n) => n.type === 'frame');
    const insideFrame = (node: BoardNode): boolean =>
      frames.some(
        (f) =>
          f.id !== node.id &&
          node.position.x >= f.position.x &&
          node.position.y >= f.position.y &&
          node.position.x + node.size.w <= f.position.x + f.size.w &&
          node.position.y + node.size.h <= f.position.y + f.size.h
      );

    const loose = this.nodes
      .filter((n) => n.type !== 'frame' && !n.locked && !insideFrame(n))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (loose.length === 0) return 0;

    const gap = 32;
    const columns = Math.max(1, Math.ceil(Math.sqrt(loose.length)));
    const colWidth = Math.max(...loose.map((n) => n.size.w)) + gap;
    const originX = Math.min(...loose.map((n) => n.position.x));
    const originY = Math.min(...loose.map((n) => n.position.y));

    const moves: Array<{ id: string; position: { x: number; y: number } }> = [];
    let x = originX;
    let y = originY;
    let rowHeight = 0;
    let col = 0;

    for (const node of loose) {
      moves.push({ id: node.id, position: { x, y } });
      rowHeight = Math.max(rowHeight, node.size.h);
      col += 1;
      if (col >= columns) {
        col = 0;
        x = originX;
        y += rowHeight + gap;
        rowHeight = 0;
      } else {
        x += colWidth;
      }
    }

    this.apply({ origin: null, label: 'Разложить доску', ops: [{ op: 'moveNodes', moves }] });
    return moves.length;
  }

  get nodes(): BoardNode[] {
    return [...this.ynodes.values()];
  }

  get edges(): BoardEdge[] {
    return [...this.yedges.values()];
  }

  get camera(): Camera {
    return CameraSchema.parse(this.ymeta.get('camera') ?? {});
  }

  /**
   * Single funnel for every mutation. `origin` is the agent id, or null for the
   * human; it decides undo tracking and stamps provenance on touched nodes.
   */
  apply(tx: BoardTransaction): BoardOp[] {
    if (this.closed) throw new Error('board is closed');
    const applied: BoardOp[] = [];
    const origin = tx.origin ?? HUMAN_ORIGIN;

    this.ydoc.transact(() => {
      for (const op of tx.ops) {
        // Capture dangling edges before applyOne deletes them from Yjs, so the
        // emitted op stream includes removeEdge and renderer mirrors stay clean.
        const cascadeEdges: BoardOp[] =
          op.op === 'removeNode'
            ? [...this.yedges.entries()]
                .filter(
                  ([, edge]) => edge.from.nodeId === op.id || edge.to.nodeId === op.id
                )
                .map(([id]) => ({ op: 'removeEdge' as const, id }))
            : [];
        if (this.applyOne(op, tx.origin)) {
          applied.push(op, ...cascadeEdges);
        }
      }
    }, origin);

    if (applied.length > 0) this.onOps.emit({ ops: applied, origin: tx.origin });
    return applied;
  }

  private applyOne(op: BoardOp, origin: string | null): boolean {
    const now = Date.now();
    switch (op.op) {
      case 'addNode': {
        const createdBy = op.node.createdBy ?? origin;
        const isHuman = origin === null || origin === HUMAN_ORIGIN;
        const incoming = op.node as BoardNode & {
          lock?: { delete?: boolean; move?: boolean; edit?: boolean };
          owner?: { kind: 'human' | 'agent'; id: string } | null;
        };
        const node = BoardNodeSchema.parse({
          ...op.node,
          createdBy,
          owner:
            incoming.owner !== undefined
              ? incoming.owner
              : isHuman
                ? { kind: 'human', id: 'human' }
                : createdBy
                  ? { kind: 'agent', id: createdBy }
                  : { kind: 'human', id: 'human' },
          lock: {
            delete: incoming.lock?.delete ?? isHuman,
            move: incoming.lock?.move ?? isHuman,
            edit: incoming.lock?.edit ?? false,
            ...(incoming.lock?.heldBy ? { heldBy: incoming.lock.heldBy } : {}),
            ...(incoming.lock?.heldUntil ? { heldUntil: incoming.lock.heldUntil } : {})
          },
          createdAt: op.node.createdAt || now,
          updatedAt: now
        });
        this.ynodes.set(node.id, node);
        return true;
      }
      case 'updateNode': {
        const current = this.ynodes.get(op.id);
        if (!current) return false;
        const next = mergeNode(current, op.patch, now);
        this.ynodes.set(op.id, next);
        return true;
      }
      case 'removeNode': {
        if (!this.ynodes.has(op.id)) return false;
        this.ynodes.delete(op.id);
        // Edges dangling off a deleted node would render as arrows to nowhere.
        for (const [id, edge] of [...this.yedges.entries()]) {
          if (edge.from.nodeId === op.id || edge.to.nodeId === op.id) this.yedges.delete(id);
        }
        return true;
      }
      case 'moveNodes': {
        let changed = false;
        for (const move of op.moves) {
          const node = this.ynodes.get(move.id);
          if (!node || node.locked) continue;
          // Agent moves respect lock.move when origin is an agent id
          if (origin && origin !== HUMAN_ORIGIN && node.lock?.move) continue;
          this.ynodes.set(move.id, { ...node, position: move.position, updatedAt: now });
          changed = true;
        }
        return changed;
      }
      case 'resizeNode': {
        const node = this.ynodes.get(op.id);
        if (!node || node.locked) return false;
        this.ynodes.set(op.id, {
          ...node,
          size: op.size,
          position: op.position ?? node.position,
          updatedAt: now
        });
        return true;
      }
      case 'reorderNode': {
        const node = this.ynodes.get(op.id);
        if (!node) return false;
        this.ynodes.set(op.id, { ...node, z: op.z, updatedAt: now });
        return true;
      }
      case 'addEdge': {
        const edge = BoardEdgeSchema.parse({ ...op.edge, createdBy: op.edge.createdBy ?? origin });
        this.yedges.set(edge.id, edge);
        return true;
      }
      case 'updateEdge': {
        const current = this.yedges.get(op.id);
        if (!current) return false;
        this.yedges.set(op.id, BoardEdgeSchema.parse({ ...current, ...op.patch }));
        return true;
      }
      case 'removeEdge': {
        if (!this.yedges.has(op.id)) return false;
        this.yedges.delete(op.id);
        return true;
      }
      case 'setCamera': {
        this.ymeta.set('camera', CameraSchema.parse(op.camera));
        return true;
      }
      case 'addLayer': {
        const layers = [...((this.ymeta.get('layers') as Layer[]) ?? [])];
        layers.push(op.layer);
        this.ymeta.set('layers', layers);
        return true;
      }
      case 'updateLayer': {
        const layers = ((this.ymeta.get('layers') as Layer[]) ?? []).map((l) =>
          l.id === op.id ? { ...l, ...op.patch } : l
        );
        this.ymeta.set('layers', layers);
        return true;
      }
      case 'removeLayer': {
        if (op.id === DEFAULT_LAYER_ID) return false;
        const layers = ((this.ymeta.get('layers') as Layer[]) ?? []).filter((l) => l.id !== op.id);
        this.ymeta.set('layers', layers);
        for (const [id, node] of [...this.ynodes.entries()]) {
          if (node.layerId === op.id) this.ynodes.set(id, { ...node, layerId: DEFAULT_LAYER_ID });
        }
        return true;
      }
      case 'addView': {
        const views = [...((this.ymeta.get('views') as NamedView[]) ?? []), op.view];
        this.ymeta.set('views', views);
        return true;
      }
      case 'removeView': {
        const views = ((this.ymeta.get('views') as NamedView[]) ?? []).filter((v) => v.id !== op.id);
        this.ymeta.set('views', views);
        return true;
      }
      case 'setBoardMeta': {
        if (op.patch.name !== undefined) this.ymeta.set('name', op.patch.name);
        if (op.patch.description !== undefined) this.ymeta.set('description', op.patch.description);
        if (op.patch.settings !== undefined) {
          const settings = (this.ymeta.get('settings') as Record<string, unknown>) ?? {};
          this.ymeta.set('settings', { ...settings, ...op.patch.settings });
        }
        return true;
      }
    }
  }

  undo(): boolean {
    const before = this.ynodes.size + this.yedges.size;
    this.undoManager.undo();
    this.onOps.emit({ ops: [], origin: null });
    return before !== this.ynodes.size + this.yedges.size || true;
  }

  redo(): boolean {
    this.undoManager.redo();
    this.onOps.emit({ ops: [], origin: null });
    return true;
  }

  /**
   * Where a new artifact should go. Agents create artifacts constantly and
   * should never have to reason about coordinates, so the store lays them out
   * inside the agent's frame in reading order and grows the frame if needed.
   */
  placeForAgent(agentId: string | null, size: { w: number; h: number }): { x: number; y: number } {
    const frame = agentId
      ? this.nodes.find((n): n is FrameNode => isAgentFrame(n) && n.agentId === agentId)
      : undefined;

    if (!frame) {
      const all = this.nodes.filter((n) => n.type !== 'frame');
      const maxY = all.reduce((acc, n) => Math.max(acc, n.position.y + n.size.h), 0);
      return { x: 80, y: all.length === 0 ? 80 : maxY + 48 };
    }

    const frameRect = rectOf(frame);
    const inside = this.nodes.filter(
      (n) =>
        n.id !== frame.id &&
        n.type !== 'frame' &&
        n.position.x < frameRect.x + frameRect.w &&
        n.position.x + n.size.w > frameRect.x &&
        n.position.y < frameRect.y + frameRect.h &&
        n.position.y + n.size.h > frameRect.y
    );

    const slot = findFreeSlot(frame, inside, size);
    const overflowsBottom = slot.y + size.h + 24 > frameRect.y + frameRect.h;
    if (overflowsBottom && frame.autoGrow && !frame.locked) {
      const grown = slot.y + size.h + 24 - frame.position.y;
      this.apply({
        origin: agentId,
        ops: [{ op: 'resizeNode', id: frame.id, size: { w: frame.size.w, h: grown } }]
      });
    }
    return slot;
  }

  /** Payloads too big or too binary for the board file. */
  async writeArtifactPayload(
    nodeId: string,
    fileName: string,
    data: string | Uint8Array,
    mime?: string
  ): Promise<PayloadRef> {
    const rel = path.posix.join('artifacts', nodeId, fileName);
    const target = path.join(this.boardDir, 'artifacts', nodeId, fileName);
    await writeFileAtomic(target, data);
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
    return { file: rel, bytes, ...(mime ? { mime } : {}) };
  }

  async readArtifactPayload(ref: PayloadRef): Promise<Buffer | undefined> {
    const target = path.join(this.boardDir, ref.file);
    try {
      return await fs.readFile(target);
    } catch {
      return undefined;
    }
  }

  /** Snapshots the previous content of an artifact so a node has a history. */
  async snapshotRevision(nodeId: string): Promise<void> {
    const node = this.ynodes.get(nodeId);
    if (!node || node.type !== 'artifact') return;
    const target = path.join(this.boardDir, 'artifacts', nodeId, 'revisions.jsonl');
    await ensureDir(path.dirname(target));
    await fs.appendFile(
      target,
      `${JSON.stringify({ rev: node.rev, at: Date.now(), artifact: node.artifact })}\n`,
      'utf8'
    );
  }

  private async writeToDisk(): Promise<void> {
    if (this.closed) return;
    const doc = this.toDoc();
    const serialized = serializeBoard(doc);
    const hash = hashContent(serialized);
    if (hash === this.lastWrittenHash) return;

    this.suppressWatch = true;
    try {
      await writeFileAtomic(path.join(this.dir, BOARD_FILE_NAME), serialized);
      await writeFileAtomic(
        path.join(this.boardDir, 'board.outline.md'),
        renderBoardOutline(doc)
      );
      this.lastWrittenHash = hash;
    } finally {
      // fs.watch fires asynchronously after the rename lands.
      setTimeout(() => {
        this.suppressWatch = false;
      }, 250);
    }
  }

  async flush(): Promise<void> {
    await this.persist.flush();
  }

  /**
   * Picks up edits made outside the app, most commonly a git checkout or
   * branch switch while the board is open.
   */
  private startWatching(): void {
    const file = path.join(this.dir, BOARD_FILE_NAME);
    let timer: NodeJS.Timeout | null = null;
    try {
      this.watcher = watch(file, () => {
        if (this.suppressWatch || this.closed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void this.reloadFromDisk(), 300);
      });
    } catch {
      // Watching is best-effort; the app still works without it.
    }
  }

  private async reloadFromDisk(): Promise<void> {
    const text = await readFileIfExists(path.join(this.dir, BOARD_FILE_NAME));
    if (text === undefined) return;
    if (hashContent(text) === this.lastWrittenHash) return;
    const parsed = parseBoard(text);
    if (!parsed.ok) {
      console.error('[board] external change is invalid, keeping in-memory state:', parsed.error);
      return;
    }
    this.loadIntoYDoc(parsed.doc);
    this.lastWrittenHash = hashContent(text);
    this.onExternalChange.emit(parsed.doc);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.persist.flush();
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    this.undoManager.destroy();
    this.ydoc.destroy();
    this.onOps.clear();
    this.onExternalChange.clear();
  }
}

/**
 * Node patches merge shallowly, except `artifact`, which merges one level
 * deeper. Agents routinely update a single artifact field (a status tone, a
 * terminal tail) and should not have to resend the whole spec.
 */
function mergeNode(current: BoardNode, patch: Record<string, unknown>, now: number): BoardNode {
  const merged: Record<string, unknown> = { ...current, ...patch, updatedAt: now };

  if (current.type === 'artifact' && patch.artifact && typeof patch.artifact === 'object') {
    merged.artifact = {
      ...current.artifact,
      ...(patch.artifact as Record<string, unknown>)
    };
    merged.rev = current.rev + 1;
  }
  if (patch.style && typeof patch.style === 'object' && 'style' in current) {
    merged.style = { ...(current as { style: object }).style, ...(patch.style as object) };
  }
  return BoardNodeSchema.parse(merged);
}
