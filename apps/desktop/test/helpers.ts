import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardsService } from '../src/main/boards/boards.service.js';
import { SkillsService } from '../src/main/skills/skills.service.js';

export interface TestContext {
  boards: BoardsService;
  skills: SkillsService;
}

export interface TestEnv {
  ctx: TestContext;
  dir: string;
  dispose: () => Promise<void>;
}

/** Board and skill services over a throwaway data directory. */
export const makeEnv = (): TestEnv => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmtki-test-'));
  const ctx: TestContext = { boards: new BoardsService(dir), skills: new SkillsService(dir) };
  return {
    ctx,
    dir,
    dispose: async () => {
      await Promise.all([ctx.boards.flush(), ctx.skills.flush()]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};
