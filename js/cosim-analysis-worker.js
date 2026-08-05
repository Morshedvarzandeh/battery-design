import { runAttachedAnalysisModules } from './cosim-analysis.js';

globalThis.addEventListener('message', (event) => {
  try {
    globalThis.postMessage({ id: event.data.id, ok: true, results: runAttachedAnalysisModules(event.data.graph) });
  } catch (error) {
    globalThis.postMessage({
      id: event.data?.id ?? -1, ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
