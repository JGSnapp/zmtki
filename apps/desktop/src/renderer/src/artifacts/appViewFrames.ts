type FrameHandler = (dataUrl: string) => void;

const listeners = new Map<string, Set<FrameHandler>>();
let wired = false;

function ensureWired(): void {
  if (wired) return;
  wired = true;
  window.zmtki.onAppViewFrame(({ nodeId, dataUrl }) => {
    const set = listeners.get(nodeId);
    if (!set) return;
    for (const handler of set) handler(dataUrl);
  });
}

/** Subscribe to streamed frames for one appView / browser node. */
export function subscribeAppViewFrame(nodeId: string, handler: FrameHandler): () => void {
  ensureWired();
  let set = listeners.get(nodeId);
  if (!set) {
    set = new Set();
    listeners.set(nodeId, set);
  }
  set.add(handler);
  return () => {
    set!.delete(handler);
    if (set!.size === 0) listeners.delete(nodeId);
  };
}
