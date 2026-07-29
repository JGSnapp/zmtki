import type { Agent } from '@zmtki/board-schema';
import type { AppDatabase } from './AppDatabase.js';

export interface DirectoryEntry {
  agentId: string;
  name: string;
  handle: string;
  boardId: string;
  boardPath: string;
  boardName: string;
  avatarColor: string;
  persona: string;
  updatedAt: number;
}

interface AgentIndexRow extends Record<string, unknown> {
  agent_id: string;
  name: string;
  handle: string;
  home_board_id: string;
  board_path: string;
  board_name: string;
  avatar_color: string;
  persona: string;
  updated_at: number;
}

/**
 * Lets a room address an agent whose project is closed.
 *
 * The board folder remains the source of truth for agent configuration; this is
 * a cache refreshed whenever a board is opened or its agents change. Without it,
 * inviting someone to a group would require opening every project first.
 */
export class AgentDirectory {
  constructor(private readonly db: AppDatabase) {}

  /** Replaces the entries for one board, dropping agents that were deleted. */
  syncBoard(boardId: string, boardPath: string, boardName: string, agents: readonly Agent[]): void {
    const keep = new Set(agents.map((a) => a.id));
    const existing = this.db.all<{ agent_id: string }>(
      'SELECT agent_id FROM agent_index WHERE home_board_id = ?',
      [boardId]
    );
    for (const row of existing) {
      if (!keep.has(row.agent_id)) {
        this.db.run('DELETE FROM agent_index WHERE agent_id = ?', [row.agent_id]);
      }
    }

    const now = Date.now();
    for (const agent of agents) {
      this.db.run(
        `INSERT INTO agent_index(agent_id, name, handle, home_board_id, board_path, board_name, avatar_color, persona, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           name = excluded.name,
           handle = excluded.handle,
           home_board_id = excluded.home_board_id,
           board_path = excluded.board_path,
           board_name = excluded.board_name,
           avatar_color = excluded.avatar_color,
           persona = excluded.persona,
           updated_at = excluded.updated_at`,
        [
          agent.id,
          agent.name,
          agent.handle,
          boardId,
          boardPath,
          boardName,
          agent.avatarColor,
          agent.persona,
          now
        ]
      );
    }
  }

  get(agentId: string): DirectoryEntry | undefined {
    const row = this.db.get<AgentIndexRow>('SELECT * FROM agent_index WHERE agent_id = ?', [agentId]);
    return row ? toEntry(row) : undefined;
  }

  byHandle(handle: string): DirectoryEntry | undefined {
    const clean = handle.replace(/^@/, '').toLowerCase();
    const row = this.db.get<AgentIndexRow>('SELECT * FROM agent_index WHERE lower(handle) = ?', [clean]);
    return row ? toEntry(row) : undefined;
  }

  all(): DirectoryEntry[] {
    return this.db.all<AgentIndexRow>('SELECT * FROM agent_index ORDER BY board_name, name').map(toEntry);
  }

  search(query: string): DirectoryEntry[] {
    const trimmed = query.trim();
    if (!trimmed) return this.all();
    const like = `%${trimmed.toLowerCase()}%`;
    return this.db
      .all<AgentIndexRow>(
        `SELECT * FROM agent_index
         WHERE lower(name) LIKE ? OR lower(handle) LIKE ? OR lower(board_name) LIKE ? OR lower(persona) LIKE ?
         ORDER BY board_name, name`,
        [like, like, like, like]
      )
      .map(toEntry);
  }

  forBoard(boardId: string): DirectoryEntry[] {
    return this.db
      .all<AgentIndexRow>('SELECT * FROM agent_index WHERE home_board_id = ? ORDER BY name', [boardId])
      .map(toEntry);
  }
}

function toEntry(row: AgentIndexRow): DirectoryEntry {
  return {
    agentId: row.agent_id,
    name: row.name,
    handle: row.handle,
    boardId: row.home_board_id,
    boardPath: row.board_path,
    boardName: row.board_name,
    avatarColor: row.avatar_color,
    persona: row.persona,
    updatedAt: row.updated_at
  };
}
