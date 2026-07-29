/** Preferred order for the quick sticker strip (basics pack ids first). */
export const POPULAR_STICKER_IDS = ['ok', 'fire', 'check', 'heart', 'rocket'] as const;

export type QuickSticker = {
  packId: string;
  stickerId: string;
  src: string;
  emoji?: string;
};

type PackLike = {
  id: string;
  stickers: Array<{ id: string; src: string; emoji?: string }>;
};

/** Pick up to `limit` popular stickers, preferring the starter pack. */
export function pickQuickStickers(packs: PackLike[], limit = 5): QuickSticker[] {
  const flat: QuickSticker[] = [];
  const ordered = [...packs].sort((a, b) => {
    if (a.id === 'basics') return -1;
    if (b.id === 'basics') return 1;
    return 0;
  });

  for (const pack of ordered) {
    for (const s of pack.stickers) {
      flat.push({
        packId: pack.id,
        stickerId: s.id,
        src: stickerImgSrc(pack.id, s.id, s.src),
        emoji: s.emoji
      });
    }
  }

  const byKey = new Map(flat.map((s) => [`${s.packId}:${s.stickerId}`, s]));
  const popular: QuickSticker[] = [];
  for (const id of POPULAR_STICKER_IDS) {
    const hit =
      byKey.get(`basics:${id}`) ?? flat.find((s) => s.stickerId === id || s.emoji === id);
    if (hit && !popular.some((p) => p.packId === hit.packId && p.stickerId === hit.stickerId)) {
      popular.push(hit);
    }
    if (popular.length >= limit) return popular;
  }

  for (const s of flat) {
    if (popular.some((p) => p.packId === s.packId && p.stickerId === s.stickerId)) continue;
    popular.push(s);
    if (popular.length >= limit) break;
  }
  return popular;
}

/** Renderer-safe sticker URL (file:// is blocked by CSP). */
export function stickerImgSrc(packId: string, stickerId: string, src?: string): string {
  if (src?.startsWith('zmtki-sticker:') || src?.startsWith('data:') || src?.startsWith('http')) {
    return src;
  }
  return `zmtki-sticker://${encodeURIComponent(packId)}/${encodeURIComponent(stickerId)}`;
}

/** @deprecated use stickerImgSrc */
export function fileUrl(src: string): string {
  if (src.startsWith('data:') || src.startsWith('http') || src.startsWith('zmtki-sticker:')) return src;
  if (src.startsWith('file:')) return src;
  // Legacy absolute paths cannot load under CSP — caller should pass pack/sticker ids.
  return src;
}
