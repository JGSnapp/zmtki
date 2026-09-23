import { useEffect, useMemo, useState } from 'react';
import type { AgentInfo } from '../../../shared/ipc';
import { HarnessIcon } from '../components/HarnessIcon';
import { api, useStore } from '../state/store';

const since = (at?: number): string => {
  if (!at) return '';
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return s + ' с назад';
  if (s < 3600) return Math.round(s / 60) + ' мин назад';
  return Math.round(s / 3600) + ' ч назад';
};

/** Highest number of subagents the panel offers. Past this a board is a queue, not a picture. */
const MAX_SUBAGENTS = 6;

const RAIL_KEY = 'zmtki:panel-rail';

/** The panel starts as a rail; the choice is remembered per machine. */
const readRail = (): boolean => {
  try {
    return window.localStorage.getItem(RAIL_KEY) !== 'wide';
  } catch {
    return true;
  }
};

/**
 * One agent: what it is doing, and the two limits the user holds over it — how
 * many subagents it may start and whether each one needs a yes. A subagent is
 * drawn nested under the agent that asked for it, so a tree of work started
 * from one harness reads as one thing.
 */
const AgentCard = ({
  agent,
  subagents,
  zones,
}: {
  agent: AgentInfo;
  subagents: AgentInfo[];
  zones: Array<{ id: string; title: string }>;
}) => {
  const focusArtifact = useStore((s) => s.focusArtifact);
  const selectZone = useStore((s) => s.selectZone);
  const limit = agent.subagentLimit;

  return (
    <div className={'agent-card' + (agent.parentId ? ' agent-card--sub' : '')} style={{ ['--agent' as string]: agent.color }}>
      <div className="agent-head">
        <span className={'agent-dot' + (agent.running ? ' is-running' : '')} />
        <span className="agent-name">{agent.label}</span>
        <span className="agent-state">{agent.running ? 'работает' : 'завершён'}</span>
      </div>
      {agent.purpose && <div className="agent-line agent-purpose">{agent.purpose}</div>}
      {agent.cwd && (
        <div className="agent-line" title={agent.cwd}>
          {agent.cwd}
        </div>
      )}
      <div className="agent-line">
        Вызовов доски: {agent.toolCalls}
        {agent.lastTool ? ' · ' + agent.lastTool + ' · ' + since(agent.lastToolAt) : ''}
      </div>
      {agent.lastError && <div className="agent-error">{agent.lastError}</div>}

      <div className="agent-rule">
        <span className="rule-label">Субагентов</span>
        <span className="stepper">
          <button
            className="chip"
            disabled={limit <= 0}
            title="Меньше субагентов"
            onClick={() => void api.agents.setPolicy(agent.id, { subagentLimit: Math.max(0, limit - 1) })}
          >
            −
          </button>
          <span className="stepper-value">
            {agent.subagentIds.length}/{limit}
          </span>
          <button
            className="chip"
            disabled={limit >= MAX_SUBAGENTS}
            title="Больше субагентов"
            onClick={() => void api.agents.setPolicy(agent.id, { subagentLimit: Math.min(MAX_SUBAGENTS, limit + 1) })}
          >
            +
          </button>
        </span>
      </div>
      <label className="agent-rule" title="Снятая галочка — субагенты стартуют сами, в пределах лимита">
        <span className="rule-label">Спрашивать разрешение</span>
        <input
          type="checkbox"
          checked={agent.requireApproval}
          onChange={(e) => void api.agents.setPolicy(agent.id, { requireApproval: e.target.checked })}
        />
      </label>
      <label className="agent-rule" title="Пока зона задана, агент кладёт блоки только внутрь неё">
        <span className="rule-label">Зона</span>
        <select
          className="agent-zone"
          value={agent.zoneId ?? ''}
          onChange={(e) => {
            const id = e.target.value || null;
            void api.agents.assignZone(agent.id, id);
            if (id) selectZone(id);
          }}
        >
          <option value="">вся доска</option>
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.title}
            </option>
          ))}
        </select>
      </label>

      <div className="agent-actions">
        <button className="chip" onClick={() => focusArtifact(agent.artifactId)}>
          К терминалу
        </button>
        {agent.lastTarget && (
          <button
            className="chip"
            onClick={() => window.dispatchEvent(new CustomEvent('zmtki:focus-rect', { detail: agent.lastTarget }))}
          >
            К месту работы
          </button>
        )}
      </div>

      {subagents.length > 0 && (
        <div className="agent-children">
          {subagents.map((child) => (
            <AgentCard key={child.id} agent={child} subagents={[]} zones={zones} />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * The side panel lists agents but never holds one: an agent's terminal lives on
 * the board, and the panel only links to it and to where the agent is working
 * (VISION: a terminal with an agent cannot be collapsed into the side panel).
 *
 * Normally it is a rail: harness marks and agent dots in one narrow column, so
 * the board keeps the screen. It opens — by the arrow, or by itself when an
 * agent asks for something — into the full panel with the settings.
 */
export const AgentsPanel = () => {
  const board = useStore((s) => s.board);
  const allAgents = useStore((s) => s.agents);
  const requests = useStore((s) => s.spawnRequests);
  // Filtered outside the selector: a selector returning a fresh array would
  // make zustand see a change on every store update.
  const agents = useMemo(() => allAgents.filter((a) => a.boardId === board?.id), [allAgents, board?.id]);
  const roots = useMemo(() => agents.filter((a) => !a.parentId || !agents.some((p) => p.id === a.parentId)), [agents]);
  const boardRequests = useMemo(() => requests.filter((r) => r.boardId === board?.id), [requests, board?.id]);
  const zones = useMemo(
    () => (board?.state.zones ?? []).filter((z) => !z.pending).map((z) => ({ id: z.id, title: z.title })),
    [board?.state.zones],
  );
  const harnesses = useStore((s) => s.harnesses);
  const mcp = useStore((s) => s.mcp);
  const mcpServers = useStore((s) => s.mcpServers);
  const setMcpServer = useStore((s) => s.setMcpServer);
  const beginPlacement = useStore((s) => s.beginPlacement);
  const resolveSpawn = useStore((s) => s.resolveSpawn);
  const focusArtifact = useStore((s) => s.focusArtifact);
  const [rail, setRail] = useState(readRail);
  const [, tick] = useState(0);

  // Relative times refresh on their own; nothing else in the panel animates.
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);

  // A question waiting for the user opens the panel: an answer is due, and the
  // rail has nowhere to put the question.
  useEffect(() => {
    if (boardRequests.length > 0) setRail(false);
  }, [boardRequests.length]);

  const setMode = (next: boolean) => {
    setRail(next);
    try {
      window.localStorage.setItem(RAIL_KEY, next ? 'rail' : 'wide');
    } catch {
      // A machine that refuses storage just starts as a rail every time.
    }
  };

  /** A harness goes onto the board like any block: carried to where the user wants it. */
  const launch = (e: React.PointerEvent, harnessId: string, label: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    beginPlacement('terminal', e.clientX, e.clientY, { harnessId, title: label, cwd: board?.rootDir ?? '' }, label);
  };

  // The mark carries the name; everything else about a harness lives in its tooltip.
  const harnessTitle = (label: string, available: boolean, wired: boolean, executable?: string | null): string =>
    label +
    ' — ' +
    (available
      ? (wired ? 'доска подключится по MCP' : 'без MCP') + (executable ? '\n' + executable : '')
      : 'не найден в PATH — откроется обычный терминал');

  if (rail) {
    return (
      <aside className="agents-panel agents-panel--rail">
        <button className="rail-toggle" title="Развернуть панель агентов" onClick={() => setMode(false)}>
          ‹
        </button>

        <div className="rail-group">
          {harnesses.map((h) => (
            <button
              key={h.id}
              className={'harness rail-item' + (h.available ? '' : ' harness--missing')}
              data-harness={h.id}
              title={harnessTitle(h.label, h.available, h.mcp, h.executable)}
              onPointerDown={(e) => launch(e, h.id, h.label)}
            >
              <HarnessIcon id={h.id} />
              {h.available && h.mcp && <span className="rail-dot" />}
            </button>
          ))}
          <button
            className="harness rail-item"
            data-harness="shell"
            title="Терминал — обычная оболочка без агента"
            onPointerDown={(e) => launch(e, 'shell', 'Терминал')}
          >
            <HarnessIcon id="shell" />
          </button>
        </div>

        {agents.length > 0 && (
          <>
            <div className="rail-sep" />
            <div className="rail-group">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  className={'rail-agent' + (agent.running ? ' is-running' : '') + (agent.parentId ? ' rail-agent--sub' : '')}
                  style={{ ['--agent' as string]: agent.color }}
                  title={
                    agent.label +
                    (agent.running ? ' — работает' : ' — завершён') +
                    (agent.lastTool ? '\n' + agent.lastTool + ' · ' + since(agent.lastToolAt) : '') +
                    '\nКлик — к терминалу, двойной — настройки'
                  }
                  onClick={() => focusArtifact(agent.artifactId)}
                  onDoubleClick={() => setMode(false)}
                >
                  {agent.label.slice(0, 1).toUpperCase()}
                </button>
              ))}
            </div>
          </>
        )}

        <div
          className="rail-foot"
          title={mcp ? 'MCP доски: 127.0.0.1:' + mcp.port + ' · ' + mcp.tools.length + ' инструментов' : 'MCP не поднят'}
        >
          {mcp ? mcp.tools.length : '—'}
        </div>
      </aside>
    );
  }

  return (
    <aside className="agents-panel">
      {boardRequests.length > 0 && (
        <section className="ask-list">
          {boardRequests.map((request) => (
            <div key={request.id} className="ask">
              <div className="ask-title">{request.parentLabel} просит субагента</div>
              <div className="ask-body">{request.purpose || 'без пояснения'}</div>
              <div className="ask-meta">
                {request.harnessId}
                {request.cwd ? ' · ' + request.cwd : ''}
              </div>
              <div className="agent-actions">
                <button className="chip chip--ok" onClick={() => void resolveSpawn(request.id, true)}>
                  Разрешить
                </button>
                <button className="chip" onClick={() => void resolveSpawn(request.id, false)}>
                  Отклонить
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section>
        <div className="panel-head">
          <h3>Запустить на доске</h3>
          <button className="chip" title="Свернуть в узкую полосу" onClick={() => setMode(true)}>
            ›
          </button>
        </div>
        <div className="harness-list">
          {harnesses.map((h) => (
            <button
              key={h.id}
              className={'harness' + (h.available ? '' : ' harness--missing')}
              data-harness={h.id}
              title={harnessTitle(h.label, h.available, h.mcp, h.executable)}
              onPointerDown={(e) => launch(e, h.id, h.label)}
            >
              <HarnessIcon id={h.id} />
              <span className="harness-name">{h.label}</span>
              {h.available ? h.mcp && <span className="harness-badge">MCP</span> : <span className="harness-badge harness-badge--off">нет</span>}
            </button>
          ))}
          <button
            className="harness"
            data-harness="shell"
            title="Обычная оболочка без агента"
            onPointerDown={(e) => launch(e, 'shell', 'Терминал')}
          >
            <HarnessIcon id="shell" />
            <span className="harness-name">Терминал</span>
          </button>
        </div>
      </section>

      {mcpServers.length > 0 && (
        <section>
          <div className="panel-head">
            <h3>Инструменты агентов</h3>
          </div>
          <div className="panel-note">
            Подключаются к агентам, запущенным после включения. Уже работающий агент сохраняет свой набор.
          </div>
          <div className="mcp-list">
            {mcpServers.map((server) => (
              <label
                key={server.id}
                className={'mcp-server' + (server.available ? '' : ' mcp-server--missing')}
                title={server.available ? server.command : 'Недоступно: нужен ' + server.requires}
              >
                <input
                  type="checkbox"
                  checked={server.enabled}
                  disabled={!server.available}
                  onChange={(e) => void setMcpServer(server.id, e.target.checked)}
                />
                <span className="mcp-server-body">
                  <span className="mcp-server-name">{server.label}</span>
                  <span className="mcp-server-hint">{server.available ? server.hint : 'Нужен ' + server.requires}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3>
          Агенты <span className="count">{agents.length}</span>
        </h3>
        {agents.length === 0 && (
          <div className="panel-empty">
            Перетащите харнесс на доску: там появится его терминал, а агент получит доску через MCP.
          </div>
        )}
        {roots.map((agent) => (
          <AgentCard key={agent.id} agent={agent} subagents={agents.filter((a) => a.parentId === agent.id)} zones={zones} />
        ))}
      </section>

      {mcp && (
        <section className="panel-foot">
          MCP доски: 127.0.0.1:{mcp.port} · {mcp.tools.length} инструментов
        </section>
      )}
    </aside>
  );
};
