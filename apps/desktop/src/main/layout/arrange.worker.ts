import { parentPort } from 'node:worker_threads';
import { runArrange, type ArrangeRequest } from './arrange.run.js';

/**
 * The thread the layout engine runs on. All it does is hand messages to
 * `runArrange`; the reasoning for running it off the main thread is there.
 */
parentPort?.on('message', (request: ArrangeRequest) => {
  try {
    parentPort?.postMessage(runArrange(request));
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
