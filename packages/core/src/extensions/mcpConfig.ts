import path from 'node:path';
import { ensureDir, pathExists, readFileIfExists, writeFileAtomic } from '../util/fs.js';
import type { ExtensionScope, McpServerConfig, McpServersFile } from './types.js';

export async function readMcpFile(filePath: string): Promise<McpServersFile> {
  if (!(await pathExists(filePath))) return { mcpServers: {} };
  try {
    const text = await readFileIfExists(filePath);
    if (!text) return { mcpServers: {} };
    const parsed = JSON.parse(text) as McpServersFile;
    return { mcpServers: parsed.mcpServers ?? {} };
  } catch {
    return { mcpServers: {} };
  }
}

export async function writeMcpFile(filePath: string, data: McpServersFile): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/** Board entries override global ones with the same name. */
export async function loadMergedMcpConfig(
  globalDir: string,
  boardDir: string | null
): Promise<Array<{ name: string; scope: ExtensionScope; config: McpServerConfig }>> {
  const globalFile = path.join(globalDir, 'mcp.json');
  const boardFile = boardDir ? path.join(boardDir, '.zmtki', 'mcp.json') : null;

  const global = await readMcpFile(globalFile);
  const board = boardFile ? await readMcpFile(boardFile) : { mcpServers: {} };

  const byName = new Map<string, { name: string; scope: ExtensionScope; config: McpServerConfig }>();
  for (const [name, config] of Object.entries(global.mcpServers)) {
    byName.set(name, { name, scope: 'global', config });
  }
  for (const [name, config] of Object.entries(board.mcpServers)) {
    byName.set(name, { name, scope: 'board', config });
  }
  return [...byName.values()];
}

export async function upsertMcpServer(
  scope: ExtensionScope,
  globalDir: string,
  boardDir: string | null,
  name: string,
  config: McpServerConfig
): Promise<void> {
  const file =
    scope === 'global'
      ? path.join(globalDir, 'mcp.json')
      : path.join(requireBoard(boardDir), '.zmtki', 'mcp.json');
  const current = await readMcpFile(file);
  current.mcpServers[name] = config;
  await writeMcpFile(file, current);
}

export async function removeMcpServer(
  scope: ExtensionScope,
  globalDir: string,
  boardDir: string | null,
  name: string
): Promise<void> {
  const file =
    scope === 'global'
      ? path.join(globalDir, 'mcp.json')
      : path.join(requireBoard(boardDir), '.zmtki', 'mcp.json');
  const current = await readMcpFile(file);
  delete current.mcpServers[name];
  await writeMcpFile(file, current);
}

function requireBoard(boardDir: string | null): string {
  if (!boardDir) throw new Error('нет активной доски для board MCP');
  return boardDir;
}

/** Ensures empty mcp.json exists for first-run UX. */
export async function ensureMcpScaffold(globalDir: string): Promise<void> {
  const file = path.join(globalDir, 'mcp.json');
  if (!(await pathExists(file))) {
    await writeMcpFile(file, { mcpServers: {} });
  }
  await ensureDir(path.join(globalDir, 'skills'));
}
