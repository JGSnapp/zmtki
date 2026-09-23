import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexServerArgs, mcpConfig } from '../src/main/harness/registry.js';
import { McpServersService } from '../src/main/mcp/servers.js';

const dirs: string[] = [];
const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmtki-mcp-test-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ENDPOINT = 'http://127.0.0.1:1234/mcp/token';
const PLAYWRIGHT = { id: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--browser', 'chrome'] };

/**
 * Capabilities the user grants their agents. What matters is that a choice
 * survives, that it reaches the harness in the shape that harness reads, and
 * that the board's own server is never the thing that gets switched off.
 */
describe('extra MCP servers', () => {
  it('starts with everything off and remembers a choice', async () => {
    const dir = makeDir();
    const first = new McpServersService(dir);
    const catalogue = first.list();
    expect(catalogue.length).toBeGreaterThan(0);
    expect(catalogue.every((server) => !server.enabled)).toBe(true);
    expect(first.launches()).toEqual([]);

    first.setEnabled('playwright', true);
    expect(first.list().find((s) => s.id === 'playwright')?.enabled).toBe(true);
    await first.flush();

    // A second run of the app is the only test of "remembered" that counts.
    const second = new McpServersService(dir);
    expect(second.list().find((s) => s.id === 'playwright')?.enabled).toBe(true);
    await second.flush();
  });

  it('ignores a server it has never heard of', async () => {
    const service = new McpServersService(makeDir());
    service.setEnabled('not-a-server', true);
    expect(service.list().some((s) => s.id === 'not-a-server')).toBe(false);
    expect(service.launches().some((s) => s.id === 'not-a-server')).toBe(false);
    await service.flush();
  });

  it('offers a server it cannot run, and never launches it', async () => {
    const service = new McpServersService(makeDir());
    for (const server of service.list()) {
      // Whatever this machine can or cannot do, the two answers must agree:
      // nothing unavailable may end up in a launch.
      if (!server.available) {
        service.setEnabled(server.id, true);
        expect(service.launches().some((s) => s.id === server.id)).toBe(false);
        expect(server.requires.length).toBeGreaterThan(0);
      }
    }
    await service.flush();
  });

  it('hands Claude Code a config with the board and the extras', () => {
    const parsed = JSON.parse(mcpConfig(ENDPOINT, [PLAYWRIGHT]));
    expect(parsed.mcpServers.board).toEqual({ type: 'http', url: ENDPOINT });
    expect(parsed.mcpServers.playwright).toEqual({ command: 'npx', args: PLAYWRIGHT.args });
    // With no extras the board is still there and alone.
    expect(Object.keys(JSON.parse(mcpConfig(ENDPOINT, [])).mcpServers)).toEqual(['board']);
  });

  it('hands Codex the same set as dotted overrides it can parse', () => {
    const args = codexServerArgs([PLAYWRIGHT]);
    // Pairs of `-c key=value`, values as JSON so TOML reads them back.
    expect(args).toEqual([
      '-c',
      'mcp_servers.playwright.command="npx"',
      '-c',
      'mcp_servers.playwright.args=["-y","@playwright/mcp@latest","--browser","chrome"]',
    ]);
    expect(JSON.parse(args[3].split('=').slice(1).join('='))).toEqual(PLAYWRIGHT.args);
    expect(codexServerArgs([])).toEqual([]);
  });
});
