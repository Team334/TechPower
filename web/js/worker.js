// Reads and analyzes one match's logs off the main thread, so the page stays responsive.
import { analyzeMatch } from './analysis.js';

self.onmessage = async ({ data: { files, config, matchName, warnings } }) => {
  try {
    const logs = {};
    for (const [role, file] of Object.entries(files)) {
      logs[role] = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    }
    const result = analyzeMatch(logs, config, matchName);
    result.warnings.unshift(...warnings);
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
