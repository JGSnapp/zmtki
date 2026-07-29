import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store.js';
import { useNavigation } from '../hooks/useNavigation.js';

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

/**
 * One search box over everything addressable: agents, artifacts, rooms,
 * projects and actions. With several boards and a few dozen artifacts each,
 * this is faster than hunting on the canvas.
 */
export function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.paletteOpen);
  const toggle = useStore((s) => s.togglePalette);
  const boards = useStore((s) => s.boards);
  const board = useStore((s) => s.activeBoard());
  const agents = useStore((s) => s.agents);
  const rooms = useStore((s) => s.rooms);
  const setActiveBoard = useStore((s) => s.setActiveBoard);
  const setActiveRoom = useStore((s) => s.setActiveRoom);
  const toggleSettings = useStore((s) => s.toggleSettings);
  const { focusNode, focusAgent } = useNavigation();

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      window.setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    // Indexing every node of every board is not free, and the palette is closed
    // almost all of the time.
    if (!open) return [];
    const list: Command[] = [];

    for (const agent of agents) {
      list.push({
        id: `agent:${agent.id}`,
        label: agent.name,
        hint: `агент @${agent.handle} · ${agent.status}`,
        run: () => focusAgent(agent.id)
      });
    }

    for (const room of rooms) {
      list.push({
        id: `room:${room.id}`,
        label: room.title,
        hint: `чат · ${room.members.length} участников`,
        run: () => setActiveRoom(room.id)
      });
    }

    for (const project of boards.values()) {
      list.push({
        id: `board:${project.doc.id}`,
        label: project.doc.name,
        hint: `проект · ${project.path}`,
        run: () => setActiveBoard(project.doc.id)
      });
    }

    if (board) {
      for (const node of board.nodes.values()) {
        if (node.type === 'frame') continue;
        const title =
          node.type === 'artifact'
            ? node.artifact.title || node.artifact.kind
            : 'text' in node
              ? node.text.slice(0, 60)
              : node.type;
        if (!title) continue;
        list.push({
          id: `node:${node.id}`,
          label: title,
          hint: node.type === 'artifact' ? `артефакт · ${node.artifact.kind}` : node.type,
          run: () => focusNode(node.id)
        });
      }
    }

    list.push({
      id: 'action:settings',
      label: 'Настройки',
      hint: 'провайдеры, поиск, лимиты',
      run: () => toggleSettings(true)
    });

    return list;
  }, [open, agents, board, boards, focusAgent, focusNode, rooms, setActiveBoard, setActiveRoom, toggleSettings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 40);
    return commands
      .map((command) => {
        const label = command.label.toLowerCase();
        // Prefix hits rank above substring hits, which matters once a board has
        // dozens of similarly named artifacts.
        const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : command.hint.includes(q) ? 2 : -1;
        return { command, score };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 40)
      .map((entry) => entry.command);
  }, [commands, query]);

  if (!open) return null;

  return (
    <div className="modal-backdrop palette" onClick={() => toggle(false)}>
      <div className="palette-box" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={query}
          placeholder="Перейти к агенту, артефакту, чату или проекту…"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(filtered.length - 1, i + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            }
            if (e.key === 'Enter') {
              filtered[index]?.run();
              toggle(false);
            }
            if (e.key === 'Escape') toggle(false);
          }}
        />
        <ul className="palette-list">
          {filtered.map((command, i) => (
            <li
              key={command.id}
              className={i === index ? 'on' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                command.run();
                toggle(false);
              }}
            >
              <span className="palette-label">{command.label}</span>
              <span className="palette-hint">{command.hint}</span>
            </li>
          ))}
          {filtered.length === 0 && <li className="palette-empty">Ничего не найдено</li>}
        </ul>
      </div>
    </div>
  );
}
