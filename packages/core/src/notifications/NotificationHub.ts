import { newId } from '@zmtki/board-schema';
import {
  NotificationSchema,
  type DeepLink,
  type Notification,
  type NotificationAction,
  type NotificationKind,
  type Severity
} from '@zmtki/protocol';
import type { AppDatabase } from '../app/AppDatabase.js';
import type { AppSettings } from '../app/settings.js';
import { Emitter } from '../util/emitter.js';

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: Partial<DeepLink>;
  actions?: NotificationAction[];
  /** Bursts sharing a key collapse into one row with a count. */
  coalesceKey?: string;
}

const SEVERITY_BY_KIND: Record<NotificationKind, Severity> = {
  approvalRequired: 'blocking',
  questionAsked: 'blocking',
  roomPaused: 'blocking',
  budgetExceeded: 'blocking',
  turnFailed: 'attention',
  turnComplete: 'attention',
  commentReply: 'attention',
  mentioned: 'attention',
  artifactCreated: 'info',
  commandFinished: 'info'
};

const COALESCE_WINDOW_MS = 60_000;

/**
 * Central notification routing.
 *
 * Severity is derived from kind rather than chosen at each call site, so the
 * same event never arrives as a popup in one place and a silent badge in
 * another. Only 'blocking' is allowed to interrupt — with several agents on
 * several boards, anything looser becomes noise the user learns to ignore.
 */
export class NotificationHub {
  readonly onNew = new Emitter<Notification>();
  readonly onUpdated = new Emitter<Notification>();
  readonly onCleared = new Emitter<string[]>();
  /** Fires only for notifications that should reach the OS. */
  readonly onOsAlert = new Emitter<Notification>();

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: () => AppSettings,
    /** Board the user is looking at; used by focus mode. */
    private readonly activeBoardId: () => string | null
  ) {}

  notify(input: NotifyInput): Notification {
    const severity = SEVERITY_BY_KIND[input.kind];
    const link: DeepLink = {
      boardId: input.link?.boardId ?? null,
      nodeId: input.link?.nodeId ?? null,
      roomId: input.link?.roomId ?? null,
      agentId: input.link?.agentId ?? null
    };

    const coalesceKey = input.coalesceKey ?? '';
    if (coalesceKey) {
      const existing = this.findCoalescable(coalesceKey);
      if (existing) {
        const updated: Notification = {
          ...existing,
          count: existing.count + 1,
          title: input.title,
          body: input.body ?? existing.body,
          createdAt: Date.now(),
          read: false
        };
        this.save(updated);
        this.onUpdated.emit(updated);
        return updated;
      }
    }

    const notification = NotificationSchema.parse({
      id: newId('notification'),
      kind: input.kind,
      severity,
      title: input.title,
      body: input.body ?? '',
      link,
      actions: input.actions ?? [],
      createdAt: Date.now(),
      coalesceKey
    });

    this.save(notification);
    this.onNew.emit(notification);
    if (this.shouldAlertOs(notification)) this.onOsAlert.emit(notification);
    return notification;
  }

  /**
   * Focus mode keeps everything except blockers to the badge, and blockers
   * always get through — otherwise a paused agent could wait unnoticed.
   */
  private shouldAlertOs(notification: Notification): boolean {
    if (notification.severity === 'blocking') return true;
    const settings = this.settings();
    if (settings.focusMode) return false;
    if (notification.severity === 'info') return false;
    // Attention-level events on the board being watched are already visible.
    return notification.link.boardId !== this.activeBoardId();
  }

  list(limit = 100): Notification[] {
    return this.db
      .all<{ json: string }>('SELECT json FROM notifications ORDER BY created_at DESC LIMIT ?', [limit])
      .map((row) => NotificationSchema.parse(JSON.parse(row.json)));
  }

  unread(): Notification[] {
    return this.list(200).filter((n) => !n.read);
  }

  counts(): { blocking: number; attention: number; info: number } {
    const out = { blocking: 0, attention: 0, info: 0 };
    for (const n of this.unread()) out[n.severity] += 1;
    return out;
  }

  countsByBoard(): Record<string, { blocking: number; attention: number; info: number }> {
    const out: Record<string, { blocking: number; attention: number; info: number }> = {};
    for (const n of this.unread()) {
      const key = n.link.boardId ?? 'app';
      out[key] ??= { blocking: 0, attention: 0, info: 0 };
      out[key][n.severity] += 1;
    }
    return out;
  }

  markRead(ids: readonly string[]): void {
    for (const id of ids) {
      const existing = this.get(id);
      if (!existing) continue;
      this.save({ ...existing, read: true });
    }
  }

  markAllRead(): void {
    this.db.run('UPDATE notifications SET read = 1, json = json');
    for (const n of this.list(500)) {
      if (n.read) continue;
      this.save({ ...n, read: true });
    }
  }

  /** Records which action was taken so the row renders as already handled. */
  resolveAction(id: string, actionId: string): Notification | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const updated: Notification = { ...existing, resolvedAction: actionId, read: true };
    this.save(updated);
    this.onUpdated.emit(updated);
    return updated;
  }

  clear(ids: readonly string[]): void {
    for (const id of ids) this.db.run('DELETE FROM notifications WHERE id = ?', [id]);
    this.onCleared.emit([...ids]);
  }

  clearRead(): void {
    const ids = this.list(500)
      .filter((n) => n.read)
      .map((n) => n.id);
    this.clear(ids);
  }

  get(id: string): Notification | undefined {
    const row = this.db.get<{ json: string }>('SELECT json FROM notifications WHERE id = ?', [id]);
    return row ? NotificationSchema.parse(JSON.parse(row.json)) : undefined;
  }

  private findCoalescable(key: string): Notification | undefined {
    const row = this.db.get<{ json: string }>(
      'SELECT json FROM notifications WHERE coalesce_key = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
      [key, Date.now() - COALESCE_WINDOW_MS]
    );
    return row ? NotificationSchema.parse(JSON.parse(row.json)) : undefined;
  }

  private save(notification: Notification): void {
    this.db.run(
      `INSERT INTO notifications(id, created_at, read, coalesce_key, json)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, read = excluded.read, json = excluded.json`,
      [
        notification.id,
        notification.createdAt,
        notification.read ? 1 : 0,
        notification.coalesceKey,
        JSON.stringify(notification)
      ]
    );
  }
}
