// Rebuilds web/examples/<id>.json from the example logs listed in web/config.json.
// GitHub Pages can't serve Git LFS files, so the site ships these results instead of the logs.
// Run after `git lfs pull`:  node tools/build-examples.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { analyzeMatch } from '../web/js/analysis.js';

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('web/config.json', root), 'utf8'));
const outDir = new URL('web/examples/', root);
mkdirSync(outDir, { recursive: true });

for (const sess of config.example_logs?.sessions ?? []) {
  const logs = {};
  for (const [role, key] of [['main', 'wpilog'], ['swerve', 'hoot_swerve'], ['subsystems', 'hoot_subsystems']]) {
    const file = sess[key] && new URL(sess[key], root);
    if (file && existsSync(file)) logs[role] = { name: basename(sess[key]), bytes: readFileSync(file) };
  }
  if (!logs.main) throw new Error(`Example log for ${sess.name} is missing (${sess.wpilog}).`);

  const started = performance.now();
  const json = JSON.stringify(analyzeMatch(logs, config, sess.name));
  writeFileSync(new URL(`${sess.id}.json`, outDir), json);
  console.log(`${sess.id}: ${Math.round(performance.now() - started)} ms, ${(json.length / 1024).toFixed(0)} KB`);
}
