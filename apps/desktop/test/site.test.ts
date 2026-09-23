import { describe, expect, it } from 'vitest';
import { SITE_WIDTH, fitSite } from '../src/renderer/src/artifacts/site.js';

/**
 * A website in a card is a window onto a page, not a page squeezed into a box.
 * These pin the arithmetic that decides how big a viewport the page is given
 * and by how much the result is shrunk to land in the card.
 */
describe('fitting a site into a card', () => {
  it('lays a small card out at a desktop width and scales it down', () => {
    // The size an agent actually used for a row of reference sites.
    const fit = fitSite(290, 320);
    expect(fit.page).toBe(SITE_WIDTH);
    expect(fit.scale).toBeCloseTo(290 / SITE_WIDTH, 5);
    // The page keeps the card's shape, so nothing inside is stretched.
    expect(fit.pageHeight / fit.page).toBeCloseTo(320 / 290, 3);
  });

  it('leaves a card with room to spare at its own size', () => {
    const fit = fitSite(1600, 900);
    expect(fit.page).toBe(1600);
    expect(fit.pageHeight).toBe(900);
    // Never blown up: that would only cost sharpness.
    expect(fit.scale).toBe(1);
  });

  it('treats a card exactly as wide as the desktop width as needing no scaling', () => {
    const fit = fitSite(SITE_WIDTH, 700);
    expect(fit.page).toBe(SITE_WIDTH);
    expect(fit.scale).toBe(1);
    expect(fit.pageHeight).toBe(700);
  });

  it('answers safely before the card has been measured', () => {
    for (const fit of [fitSite(0, 0), fitSite(0, 400), fitSite(-5, 10)]) {
      expect(fit.page).toBe(SITE_WIDTH);
      expect(fit.scale).toBe(1);
      expect(Number.isFinite(fit.pageHeight)).toBe(true);
    }
  });
});
