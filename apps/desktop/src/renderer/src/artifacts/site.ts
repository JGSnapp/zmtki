/**
 * How a whole website is fitted into a card.
 *
 * A site asked to lay out in 290 CSS pixels does what it would do on a phone
 * held sideways: it collapses to its narrow layout, raises scrollbars, and
 * becomes something nobody can read. A card is not a phone — it is a window
 * onto a page, and the board already has a zoom for looking closer.
 *
 * So the page is given a desktop viewport and the result is scaled down to the
 * card. The site believes it is on a 1280px screen, which is what its layout
 * was written for, and zooming the board magnifies that layout instead of
 * re-flowing it into something narrower the closer you look.
 */
export const SITE_WIDTH = 1280;

export interface SiteFit {
  /** Viewport width the page is laid out at. */
  page: number;
  /** And its height, so the page's shape is the card's and nothing is stretched. */
  pageHeight: number;
  /** What the result is multiplied by to land in the card; never above 1. */
  scale: number;
}

/**
 * A card wider than `SITE_WIDTH` gets the page at its own size: there is
 * nothing to gain from laying a site out narrower than the room it has, and
 * blowing it up would only cost sharpness.
 */
export const fitSite = (width: number, height: number): SiteFit => {
  if (width <= 0 || height <= 0) return { page: SITE_WIDTH, pageHeight: 0, scale: 1 };
  const page = Math.max(width, SITE_WIDTH);
  const scale = width / page;
  return { page, pageHeight: Math.round(height / scale), scale };
};
