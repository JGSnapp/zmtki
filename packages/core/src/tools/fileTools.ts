import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { DEFAULT_ARTIFACT_SIZE, createArtifactNode } from '@zmtki/board-schema';
import { bool, defineTool, num, objectSchema, str, type ToolContext, type ToolResult } from './registry.js';
import { confineToRoot, listFilesRecursive, toPosix } from '../util/fs.js';

const MAX_READ_CHARS = 120_000;
const MAX_PREVIEW_CHARS = 4_000;

async function resolveWritable(ctx: ToolContext, relPath: string): Promise<string> {
  if (ctx.agent.sandboxPolicy === 'readOnly') {
    throw new Error('этому агенту запрещена запись (sandboxPolicy=readOnly)');
  }
  if (ctx.agent.sandboxPolicy === 'fullAccess') {
    return path.isAbsolute(relPath) ? relPath : path.resolve(ctx.boardPath, relPath);
  }
  return confineToRoot(ctx.boardPath, relPath);
}

function countDiffLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function languageOf(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shell',
    sql: 'sql'
  };
  return map[ext] ?? ext ?? 'plaintext';
}

/** Every write puts a diff artifact on the board, so edits are never invisible. */
async function publishDiff(
  ctx: ToolContext,
  relPath: string,
  before: string,
  after: string
): Promise<string> {
  const patch = createTwoFilesPatch(relPath, relPath, before, after, '', '', { context: 3 });
  const { additions, deletions } = countDiffLines(patch);
  const size = DEFAULT_ARTIFACT_SIZE.diff;
  const node = createArtifactNode({
    artifact: {
      kind: 'diff',
      title: relPath,
      tone: 'success',
      path: relPath,
      patch: patch.slice(0, 60_000),
      additions,
      deletions,
      applied: true
    },
    position: ctx.board.placeForAgent(ctx.agent.id, size),
    size,
    createdBy: ctx.agent.id
  });
  ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
  return node.id;
}

defineTool({
  name: 'read_file',
  toolset: 'files',
  readOnly: true,
  description:
    'Прочитать файл проекта. Можно указать диапазон строк. Файл не попадает на доску автоматически — если он важен для отчёта, создай артефакт file или fileFragment.',
  parameters: objectSchema(
    {
      path: str('Путь относительно папки доски'),
      startLine: num('Первая строка, с 1'),
      endLine: num('Последняя строка включительно')
    },
    ['path']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const rel = String(args.path);
    const abs = await confineToRoot(ctx.boardPath, rel);
    let text: string;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch (err) {
      return { content: `не удалось прочитать ${rel}: ${(err as Error).message}`, isError: true };
    }

    const lines = text.split('\n');
    const start = typeof args.startLine === 'number' ? Math.max(1, args.startLine) : 1;
    const end = typeof args.endLine === 'number' ? Math.min(lines.length, args.endLine) : lines.length;
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, i) => `${start + i}| ${line}`).join('\n');

    return {
      content:
        numbered.length > MAX_READ_CHARS
          ? `${numbered.slice(0, MAX_READ_CHARS)}\n[обрезано, всего строк ${lines.length}]`
          : numbered || '[пустой файл]'
    };
  }
});

defineTool({
  name: 'write_file',
  toolset: 'files',
  readOnly: false,
  description:
    'Записать файл целиком, создав его при необходимости. На доске появится дифф с изменениями. Для точечных правок существующего файла лучше apply_patch.',
  parameters: objectSchema({ path: str('Путь относительно папки доски'), content: str('Новое содержимое') }, [
    'path',
    'content'
  ]),
  async handler(args, ctx): Promise<ToolResult> {
    const rel = String(args.path);
    const content = String(args.content);

    let abs: string;
    try {
      abs = await resolveWritable(ctx, rel);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    if (ctx.agent.approvalPolicy !== 'never') {
      const approved = await ctx.requestApproval({
        kind: 'write',
        title: 'Запись файла',
        detail: `${content.length} символов`,
        subject: rel
      });
      if (!approved) return { content: 'запись отклонена пользователем', isError: true };
    }

    const before = await fs.readFile(abs, 'utf8').catch(() => '');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const nodeId = await publishDiff(ctx, rel, before, content);
    return { content: `Файл ${rel} записан (${content.split('\n').length} строк).`, nodeId };
  }
});

defineTool({
  name: 'apply_patch',
  toolset: 'files',
  readOnly: false,
  description:
    'Точечно заменить фрагмент файла. oldString должен встречаться ровно один раз, если не задан replaceAll. На доске появится дифф.',
  parameters: objectSchema(
    {
      path: str('Путь относительно папки доски'),
      oldString: str('Точный текст, который надо заменить'),
      newString: str('Текст замены'),
      replaceAll: bool('Заменить все вхождения')
    },
    ['path', 'oldString', 'newString']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const rel = String(args.path);
    const oldString = String(args.oldString);
    const newString = String(args.newString);
    const replaceAll = args.replaceAll === true;

    let abs: string;
    try {
      abs = await resolveWritable(ctx, rel);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }

    let before: string;
    try {
      before = await fs.readFile(abs, 'utf8');
    } catch (err) {
      return { content: `не удалось прочитать ${rel}: ${(err as Error).message}`, isError: true };
    }

    const occurrences = before.split(oldString).length - 1;
    if (occurrences === 0) {
      return { content: `oldString не найден в ${rel}`, isError: true };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        content: `oldString встречается ${occurrences} раз в ${rel}; уточни фрагмент или передай replaceAll`,
        isError: true
      };
    }

    if (ctx.agent.approvalPolicy !== 'never') {
      const approved = await ctx.requestApproval({
        kind: 'write',
        title: 'Правка файла',
        detail: `-${oldString.split('\n').length} / +${newString.split('\n').length} строк`,
        subject: rel
      });
      if (!approved) return { content: 'правка отклонена пользователем', isError: true };
    }

    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);
    await fs.writeFile(abs, after, 'utf8');
    const nodeId = await publishDiff(ctx, rel, before, after);
    return { content: `Файл ${rel} изменён (${occurrences} замен).`, nodeId };
  }
});

defineTool({
  name: 'list_files',
  toolset: 'files',
  readOnly: true,
  description: 'Показать дерево файлов проекта. Служебные папки вроде node_modules и .git пропускаются.',
  parameters: objectSchema({
    subdir: str('Подпапка относительно папки доски'),
    limit: num('Максимум файлов, по умолчанию 500')
  }),
  async handler(args, ctx): Promise<ToolResult> {
    const subdir = args.subdir ? String(args.subdir) : '.';
    const abs = await confineToRoot(ctx.boardPath, subdir);
    const limit = typeof args.limit === 'number' ? args.limit : 500;
    const files = await listFilesRecursive(abs, { maxEntries: limit });
    if (files.length === 0) return { content: 'файлов не найдено' };
    return { content: `${files.length} файлов:\n${files.join('\n')}` };
  }
});

defineTool({
  name: 'search_files',
  toolset: 'files',
  readOnly: true,
  description: 'Найти текст или регулярное выражение в файлах проекта. Возвращает совпадения с номерами строк.',
  parameters: objectSchema(
    {
      pattern: str('Регулярное выражение или подстрока'),
      glob: str('Фильтр по расширению, например .ts'),
      limit: num('Максимум совпадений, по умолчанию 60')
    },
    ['pattern']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const limit = typeof args.limit === 'number' ? args.limit : 60;
    const extFilter = args.glob ? String(args.glob).replace(/^\*/, '') : '';

    let regex: RegExp;
    try {
      regex = new RegExp(String(args.pattern), 'i');
    } catch {
      regex = new RegExp(escapeRegExp(String(args.pattern)), 'i');
    }

    const files = await listFilesRecursive(ctx.boardPath, { maxEntries: 4000 });
    const hits: string[] = [];

    for (const rel of files) {
      if (hits.length >= limit) break;
      if (extFilter && !rel.endsWith(extFilter)) continue;
      const abs = path.join(ctx.boardPath, rel);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || stat.size > 2_000_000) continue;
      const text = await fs.readFile(abs, 'utf8').catch(() => null);
      if (text === null) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
        const line = lines[i] as string;
        if (regex.test(line)) hits.push(`${toPosix(rel)}:${i + 1}: ${line.trim().slice(0, 200)}`);
      }
    }

    if (hits.length === 0) return { content: `совпадений не найдено: ${args.pattern}` };
    return { content: `${hits.length} совпадений:\n${hits.join('\n')}` };
  }
});

defineTool({
  name: 'show_file',
  toolset: 'files',
  readOnly: false,
  description:
    'Вынести файл или его фрагмент на доску как артефакт, чтобы он был виден в отчёте. Для фрагмента задай startLine и endLine.',
  parameters: objectSchema(
    {
      path: str('Путь относительно папки доски'),
      startLine: num('Первая строка фрагмента'),
      endLine: num('Последняя строка фрагмента')
    },
    ['path']
  ),
  async handler(args, ctx): Promise<ToolResult> {
    const rel = String(args.path);
    const abs = await confineToRoot(ctx.boardPath, rel);
    const text = await fs.readFile(abs, 'utf8').catch(() => null);
    if (text === null) return { content: `не удалось прочитать ${rel}`, isError: true };

    const isFragment = typeof args.startLine === 'number' && typeof args.endLine === 'number';
    const language = languageOf(rel);

    if (isFragment) {
      const lines = text.split('\n');
      const start = Math.max(1, args.startLine as number);
      const end = Math.min(lines.length, args.endLine as number);
      const size = DEFAULT_ARTIFACT_SIZE.fileFragment;
      const node = createArtifactNode({
        artifact: {
          kind: 'fileFragment',
          title: `${rel}:${start}-${end}`,
          tone: 'idle',
          path: rel,
          startLine: start,
          endLine: end,
          language,
          content: lines.slice(start - 1, end).join('\n')
        },
        position: ctx.board.placeForAgent(ctx.agent.id, size),
        size,
        createdBy: ctx.agent.id
      });
      ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
      return { content: `Фрагмент ${rel}:${start}-${end} вынесен на доску.`, nodeId: node.id };
    }

    const size = DEFAULT_ARTIFACT_SIZE.file;
    const node = createArtifactNode({
      artifact: {
        kind: 'file',
        title: rel,
        tone: 'idle',
        path: rel,
        language,
        preview: text.slice(0, MAX_PREVIEW_CHARS),
        truncated: text.length > MAX_PREVIEW_CHARS
      },
      position: ctx.board.placeForAgent(ctx.agent.id, size),
      size,
      createdBy: ctx.agent.id
    });
    ctx.board.apply({ origin: ctx.agent.id, ops: [{ op: 'addNode', node }] });
    return { content: `Файл ${rel} вынесен на доску.`, nodeId: node.id };
  }
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
