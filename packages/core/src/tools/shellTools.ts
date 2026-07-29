import path from 'node:path';
import { DEFAULT_ARTIFACT_SIZE, createArtifactNode } from '@zmtki/board-schema';
import { defineTool, num, objectSchema, str, type ToolResult } from './registry.js';
import { confineToRoot } from '../util/fs.js';

const MAX_OUTPUT_IN_CONTEXT = 24_000;

/** Commands that are destructive enough to always ask, regardless of policy. */
const ALWAYS_CONFIRM = [
  /\brm\s+-rf?\b/i,
  /\bformat\b/i,
  /Remove-Item\s+.*-Recurse/i,
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\bmkfs\b/i,
  /:\s*\(\)\s*\{.*\}\s*;/
];

defineTool({
  name: 'shell',
  toolset: 'shell',
  readOnly: false,
  description:
    'Выполнить команду в терминале. На доске сразу появляется живой терминал с выводом — это основной способ показать, что происходит. Команда выполняется в папке доски, если не указано иное.',
  parameters: objectSchema(
    {
      command: str('Команда для выполнения'),
      cwd: str('Рабочая папка относительно папки доски'),
      title: str('Заголовок терминала на доске'),
      timeoutMs: num('Лимит времени в миллисекундах, по умолчанию 120000')
    },
    ['command']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const command = String(args.command).trim();
    if (!command) return { content: 'пустая команда', isError: true };

    if (ctx.agent.sandboxPolicy === 'readOnly') {
      return { content: 'этому агенту запрещено выполнять команды (sandboxPolicy=readOnly)', isError: true };
    }

    let cwd = ctx.boardPath;
    if (args.cwd) {
      try {
        cwd = await confineToRoot(ctx.boardPath, String(args.cwd));
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    }

    const dangerous = ALWAYS_CONFIRM.some((re) => re.test(command));
    if (dangerous || ctx.agent.approvalPolicy !== 'never') {
      const approved = await ctx.requestApproval({
        kind: 'exec',
        title: dangerous ? 'Опасная команда' : 'Выполнение команды',
        detail: `в ${path.relative(ctx.boardPath, cwd) || '.'}`,
        subject: command
      });
      if (!approved) return { content: 'выполнение отклонено пользователем', isError: true };
    }

    // The artifact is created before the process starts so the user watches it
    // fill up live rather than seeing a finished log appear at the end.
    const size = DEFAULT_ARTIFACT_SIZE.terminal;
    const node = createArtifactNode({
      artifact: {
        kind: 'terminal',
        title: String(args.title ?? command.slice(0, 60)),
        tone: 'running',
        cwd: path.relative(ctx.boardPath, cwd) || '.',
        command,
        exitCode: null,
        tail: '',
        running: true
      },
      position: ctx.board.placeForAgent(ctx.agent.id, size),
      size,
      createdBy: ctx.agent.id
    });
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });

    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 120_000;
    const { exitCode, output } = await ctx.services.terminal.run({
      nodeId: node.id,
      command,
      cwd,
      timeoutMs
    });

    const tail = output.slice(-4000);
    ctx.board.apply({
      origin: ctx.agent.id,
      ops: [
        {
          op: 'updateNode',
          id: node.id,
          patch: {
            artifact: {
              running: false,
              exitCode,
              tail,
              tone: exitCode === 0 ? 'success' : 'error'
            }
          }
        }
      ]
    });

    const trimmed =
      output.length > MAX_OUTPUT_IN_CONTEXT
        ? `${output.slice(0, 4_000)}\n[...обрезано ${output.length - MAX_OUTPUT_IN_CONTEXT} символов...]\n${output.slice(-20_000)}`
        : output;

    return {
      content: `exit=${exitCode}\n${trimmed || '[пустой вывод]'}`,
      nodeId: node.id,
      isError: exitCode !== 0
    };
  }
});
