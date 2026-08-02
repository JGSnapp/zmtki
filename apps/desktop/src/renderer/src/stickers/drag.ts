import type { DragEvent } from 'react';

/** HTML5 drag payload for placing a sticker on the board. */
export const STICKER_DRAG_MIME = 'application/x-zmtki-sticker';

export type StickerDragPayload = {
  packId: string;
  stickerId: string;
};

export function setStickerDragData(event: DragEvent, payload: StickerDragPayload): void {
  const json = JSON.stringify(payload);
  event.dataTransfer.setData(STICKER_DRAG_MIME, json);
  event.dataTransfer.setData('text/plain', json);
  event.dataTransfer.effectAllowed = 'copy';
}

export function readStickerDragData(event: DragEvent): StickerDragPayload | null {
  const raw =
    event.dataTransfer.getData(STICKER_DRAG_MIME) || event.dataTransfer.getData('text/plain');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StickerDragPayload>;
    if (typeof parsed.packId === 'string' && typeof parsed.stickerId === 'string') {
      return { packId: parsed.packId, stickerId: parsed.stickerId };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function isStickerDrag(event: DragEvent): boolean {
  return [...event.dataTransfer.types].some((t) => t === STICKER_DRAG_MIME || t === 'text/plain');
}
