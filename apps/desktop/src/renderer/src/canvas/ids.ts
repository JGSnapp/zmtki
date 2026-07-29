/**
 * Client-side id generation for nodes the user draws.
 *
 * Ids are produced here rather than round-tripping through the core so a new
 * shape appears the instant it is drawn. The prefix and monotonic time
 * component match the core's scheme, so ordering stays consistent.
 */
let counter = 0;

export function newNodeId(): string {
  counter += 1;
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `nd_${time}${counter.toString(36)}${random}`;
}
