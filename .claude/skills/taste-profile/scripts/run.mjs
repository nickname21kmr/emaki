// Portable entrypoint: resolves Emaki's dependencies independently of the agent cwd.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, REPO, SKILL_DIR } from './lib.mjs';

const steps = { snapshot: 'mjs', 'wd-sample': 'mts', baseline: 'mjs', 'baseline-tag': 'mts', analyze: 'mjs', report: 'mjs' };
const step = process.argv[2];
if (!Object.hasOwn(steps, step)) {
  console.error(`用法：node <skill>/scripts/run.mjs <${Object.keys(steps).join('|')}> [--data 目录] [--out 目录] [步骤参数]`);
  process.exit(1);
}
const { dataDir, out } = args();
const forwarded = process.argv.slice(3);
for (let i = forwarded.length - 1; i >= 0; i--) {
  if (forwarded[i] === '--data' || forwarded[i] === '--out') forwarded.splice(i, 2);
}
const require = createRequire(path.join(REPO, 'apps/server/package.json'));
const loader = steps[step] === 'mts' ? ['--import', pathToFileURL(require.resolve('tsx')).href] : [];
const result = spawnSync(process.execPath, [...loader, path.join(SKILL_DIR, 'scripts', `${step}.${steps[step]}`), ...forwarded, '--data', dataDir, '--out', out], {
  cwd: REPO, stdio: 'inherit', windowsHide: true, env: { ...process.env, EMAKI_DATA_DIR: dataDir },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
