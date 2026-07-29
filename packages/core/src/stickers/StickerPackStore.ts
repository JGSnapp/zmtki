import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists, readFileIfExists, writeFileAtomic } from '../util/fs.js';

export interface StickerMeta {
  id: string;
  file: string;
  emoji?: string;
}

export interface StickerPack {
  id: string;
  name: string;
  scope: 'global' | 'board';
  dir: string;
  stickers: StickerMeta[];
}

interface PackManifest {
  id: string;
  name: string;
  stickers: StickerMeta[];
}

/**
 * Telegram-like sticker packs under ~/.zmtki/stickers and board/.zmtki/stickers.
 * Board packs override global packs with the same id.
 */
export class StickerPackStore {
  private packs = new Map<string, StickerPack>();
  private boardDir: string | null = null;

  constructor(private readonly globalDir: string) {}

  setBoardDir(boardDir: string | null): void {
    this.boardDir = boardDir;
  }

  async reload(): Promise<StickerPack[]> {
    await ensureDir(this.globalRoot());
    await this.ensureStarterPack();
    const global = await this.scanRoot(this.globalRoot(), 'global');
    const board = this.boardDir
      ? await this.scanRoot(path.join(this.boardDir, '.zmtki', 'stickers'), 'board')
      : [];
    this.packs.clear();
    for (const pack of global) this.packs.set(pack.id, pack);
    for (const pack of board) this.packs.set(pack.id, pack);
    return this.list();
  }

  list(): StickerPack[] {
    return [...this.packs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(packId: string): StickerPack | undefined {
    return this.packs.get(packId);
  }

  getSticker(
    packId: string,
    stickerId: string
  ): { pack: StickerPack; sticker: StickerMeta; src: string } | undefined {
    const pack = this.packs.get(packId);
    if (!pack) return undefined;
    const sticker = pack.stickers.find((s) => s.id === stickerId);
    if (!sticker) return undefined;
    return { pack, sticker, src: path.join(pack.dir, sticker.file) };
  }

  async upsertPack(scope: 'global' | 'board', id: string, name: string): Promise<StickerPack> {
    const root = this.rootFor(scope);
    const dir = path.join(root, sanitize(id));
    await ensureDir(dir);
    const existing = await this.readManifest(dir);
    const manifest: PackManifest = {
      id,
      name,
      stickers: existing?.stickers ?? []
    };
    await writeFileAtomic(path.join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await this.reload();
    const pack = this.packs.get(id);
    if (!pack) throw new Error('пак не сохранился');
    return pack;
  }

  async removePack(scope: 'global' | 'board', id: string): Promise<void> {
    const dir = path.join(this.rootFor(scope), sanitize(id));
    if (await pathExists(dir)) await fs.rm(dir, { recursive: true, force: true });
    await this.reload();
  }

  async addSticker(input: {
    scope: 'global' | 'board';
    packId: string;
    id: string;
    sourcePath: string;
    emoji?: string;
  }): Promise<StickerMeta> {
    const pack = this.packs.get(input.packId);
    if (!pack || pack.scope !== input.scope) {
      await this.upsertPack(input.scope, input.packId, input.packId);
    }
    const dir = path.join(this.rootFor(input.scope), sanitize(input.packId));
    await ensureDir(dir);
    const ext = path.extname(input.sourcePath).toLowerCase() || '.png';
    const file = `${sanitize(input.id)}${ext}`;
    const dest = path.join(dir, file);

    if (input.sourcePath.startsWith('data:')) {
      const match = /^data:([^;]+);base64,(.+)$/.exec(input.sourcePath);
      if (!match) throw new Error('некорректный data URL');
      await fs.writeFile(dest, Buffer.from(match[2]!, 'base64'));
    } else {
      await fs.copyFile(input.sourcePath, dest);
    }

    const manifest = (await this.readManifest(dir)) ?? {
      id: input.packId,
      name: input.packId,
      stickers: []
    };
    const sticker: StickerMeta = { id: input.id, file, emoji: input.emoji };
    manifest.stickers = [
      ...manifest.stickers.filter((s) => s.id !== input.id),
      sticker
    ];
    await writeFileAtomic(path.join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await this.reload();
    return sticker;
  }

  async removeSticker(scope: 'global' | 'board', packId: string, id: string): Promise<void> {
    const dir = path.join(this.rootFor(scope), sanitize(packId));
    const manifest = await this.readManifest(dir);
    if (!manifest) return;
    const victim = manifest.stickers.find((s) => s.id === id);
    manifest.stickers = manifest.stickers.filter((s) => s.id !== id);
    await writeFileAtomic(path.join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (victim) {
      await fs.rm(path.join(dir, victim.file), { force: true }).catch(() => undefined);
    }
    await this.reload();
  }

  private async ensureStarterPack(): Promise<void> {
    const dir = path.join(this.globalRoot(), 'basics');
    const manifestPath = path.join(dir, 'pack.json');
    if (await pathExists(manifestPath)) return;
    await ensureDir(dir);

    const basics: Array<{ id: string; emoji: string; bg: string }> = [
      { id: 'ok', emoji: '👍', bg: '#2f6fed' },
      { id: 'fire', emoji: '🔥', bg: '#e35d2a' },
      { id: 'check', emoji: '✅', bg: '#2f9e64' },
      { id: 'think', emoji: '🤔', bg: '#7a6ff0' },
      { id: 'rocket', emoji: '🚀', bg: '#1f8fbf' },
      { id: 'heart', emoji: '❤️', bg: '#d6456a' },
      { id: 'clap', emoji: '👏', bg: '#c9952a' },
      { id: 'party', emoji: '🎉', bg: '#8b5cf6' }
    ];

    const stickers: StickerMeta[] = [];
    for (const item of basics) {
      const file = `${item.id}.svg`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${item.bg}"/>
      <stop offset="100%" stop-color="#10131a"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#g)"/>
  <text x="128" y="148" text-anchor="middle" font-size="120">${item.emoji}</text>
</svg>`;
      await fs.writeFile(path.join(dir, file), svg, 'utf8');
      stickers.push({ id: item.id, file, emoji: item.emoji });
    }

    const manifest: PackManifest = {
      id: 'basics',
      name: 'Базовые',
      stickers
    };
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private globalRoot(): string {
    return path.join(this.globalDir, 'stickers');
  }

  private rootFor(scope: 'global' | 'board'): string {
    if (scope === 'global') return this.globalRoot();
    if (!this.boardDir) throw new Error('нет активной доски для board-стикеров');
    return path.join(this.boardDir, '.zmtki', 'stickers');
  }

  private async scanRoot(root: string, scope: 'global' | 'board'): Promise<StickerPack[]> {
    if (!(await pathExists(root))) return [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    const packs: StickerPack[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const manifest = await this.readManifest(dir);
      if (!manifest) continue;
      packs.push({
        id: manifest.id || entry.name,
        name: manifest.name || entry.name,
        scope,
        dir,
        stickers: manifest.stickers ?? []
      });
    }
    return packs;
  }

  private async readManifest(dir: string): Promise<PackManifest | null> {
    const text = await readFileIfExists(path.join(dir, 'pack.json'));
    if (!text) return null;
    try {
      return JSON.parse(text) as PackManifest;
    } catch {
      return null;
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'pack';
}
