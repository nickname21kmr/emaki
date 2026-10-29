// The worker registers its own TS loader, including when started by Vitest or the production launcher.
import { parentPort } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
register();
const { compareImages } = await import('./compareImages.ts');
parentPort.on('message', async ([a, b]) => {
  try {
    parentPort.postMessage({ result: await compareImages(a, b) });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
