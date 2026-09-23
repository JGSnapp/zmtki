import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../src/main/core/settings.js';

const dirs: string[] = [];
const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmtki-settings-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * View preferences used to live in the renderer's `localStorage`, where they
 * were quietly lost: the window is loaded from a `file://` URL, Chromium treats
 * that origin as opaque and throws the storage away when the window closes. So
 * what these check is the one thing that was broken — that a choice is still
 * there the next time the app starts.
 */
describe('view settings', () => {
  it('is empty to begin with', async () => {
    const service = new SettingsService(makeDir());
    expect(service.all()).toEqual({});
    await service.flush();
  });

  it('remembers a choice across a restart', async () => {
    const dir = makeDir();
    const first = new SettingsService(dir);
    expect(first.set('overviewArrows', false)).toEqual({ overviewArrows: false });
    await first.flush();

    const second = new SettingsService(dir);
    expect(second.all().overviewArrows).toBe(false);
    // And back again, because a switch has two positions.
    second.set('overviewArrows', true);
    await second.flush();
    expect(new SettingsService(dir).all().overviewArrows).toBe(true);
  });

  it('keeps preferences apart and drops one that is cleared', async () => {
    const service = new SettingsService(makeDir());
    service.set('overviewArrows', false);
    service.set('panelRail', true);
    expect(service.all()).toEqual({ overviewArrows: false, panelRail: true });
    expect(service.set('overviewArrows', null)).toEqual({ panelRail: true });
    await service.flush();
  });

  it('hands out a copy, so a caller cannot edit the stored set by accident', async () => {
    const service = new SettingsService(makeDir());
    service.set('overviewArrows', true);
    const taken = service.all();
    taken.overviewArrows = false;
    expect(service.all().overviewArrows).toBe(true);
    await service.flush();
  });
});
