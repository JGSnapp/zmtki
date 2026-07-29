import { ulid } from 'ulid';

/**
 * Prefixed ULIDs. The prefix makes ids self-describing in logs, prompts and
 * deep links, and lets us validate that a tool argument refers to the right
 * kind of thing before touching the store.
 */
export const ID_PREFIXES = {
  board: 'brd',
  node: 'nd',
  edge: 'edg',
  layer: 'lyr',
  agent: 'agt',
  room: 'rm',
  message: 'msg',
  thread: 'thr',
  comment: 'cmt',
  notification: 'ntf',
  turn: 'trn',
  toolCall: 'tc',
  revision: 'rev',
  approval: 'apr',
  endpoint: 'ep',
  file: 'fil'
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid().toLowerCase()}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${ID_PREFIXES[kind]}_`);
}

export function idKindOf(value: string): IdKind | undefined {
  const prefix = value.split('_', 1)[0];
  for (const [kind, p] of Object.entries(ID_PREFIXES)) {
    if (p === prefix) return kind as IdKind;
  }
  return undefined;
}
