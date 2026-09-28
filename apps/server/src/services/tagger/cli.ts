/**
 * 打标签命令行（T09 的验收都用它）。
 *   npm run tagger -w @emaki/server -- <download|inspect|tag|bench> [选项] [文件...]
 */
import { parseArgs } from 'node:util';
import { config } from '../../config.ts';
import { TaggerClient, TaggerCrashedError, startTagger } from './client.ts';
import { ensureModelFiles } from './download.ts';
import { DEFAULT_TAGGER_MODEL, clampBatch, findModel } from './models.ts';
import { pickRating } from './postprocess.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', default: DEFAULT_TAGGER_MODEL },
    device: { type: 'string', default: 'dml' },
    batch: { type: 'string', default: '8' },
    n: { type: 'string', default: '64' },
    general: { type: 'string', default: '0.35' },
    character: { type: 'string', default: '0.35' },
    mcut: { type: 'boolean', default: false },
    'no-fixed-batch': { type: 'boolean', default: false },
  },
});

const [cmd, ...files] = positionals;
const spec = findModel(values.model);
if (!spec) {
  console.error(`未知模型：${values.model}`);
  process.exit(1);
}
const device = values.device === 'cpu' ? 'cpu' : 'dml';
const th = {
  general: Number(values.general),
  character: Number(values.character),
  generalMcut: values.mcut,
  characterMcut: values.mcut,
};

const log = (m: string) => console.log(`[tagger] ${m}`);

async function start(): Promise<TaggerClient> {
  const { modelPath, labelsPath } = await ensureModelFiles(spec!, config.modelsDir, { log });
  const client = await startTagger({
    repo: spec!.repo,
    modelPath,
    labelsPath,
    device,
    batchSize: clampBatch(spec!, device, Number(values.batch)),
    modelsDir: config.modelsDir,
    fixedBatch: device === 'dml' && !values['no-fixed-batch'],
  });
  const i = client.info;
  log(`子进程 pid=${i.pid} · device: ${i.device}${i.device === 'dml' ? ` (#${i.dmlDeviceId})` : ''} · batch ${i.batchSize}`);
  if (i.fallbackReason) log(`回退原因：${i.fallbackReason}`);
  return client;
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'download': {
      let last = 0;
      await ensureModelFiles(spec!, config.modelsDir, {
        log,
        onProgress: (p) => {
          if (Date.now() - last < 1000) return;
          last = Date.now();
          log(`${p.file} ← ${p.source}：${(p.received / 1048576).toFixed(0)} / ${(p.total / 1048576).toFixed(0)} MB`);
        },
      });
      log('模型文件就绪');
      return;
    }
    case 'inspect': {
      const c = await start();
      console.log(JSON.stringify(c.info, null, 2));
      await c.dispose();
      return;
    }
    case 'tag': {
      if (!files.length) throw new Error('用法：tag <图片绝对路径...>');
      const c = await start();
      try {
        const results = await c.tag(files.map((path, id) => ({ id, path })), th);
        for (const r of results) {
          console.log(`\n== ${files[r.id]}`);
          if (!r.ok) {
            console.log(`  失败（${r.code}）：${r.message}`);
            continue;
          }
          if (r.rating) console.log(`  rating: ${pickRating(r.rating)}  ${JSON.stringify(r.rating)}`);
          console.log(`  character: ${r.character.map(([t, s]) => `${t} ${s.toFixed(3)}`).join(', ') || '（无）'}`);
          console.log(`  general: ${r.general.slice(0, 15).map(([t, s]) => `${t} ${s.toFixed(2)}`).join(', ')}`);
        }
      } finally {
        await c.dispose();
      }
      return;
    }
    case 'bench': {
      const file = files[0];
      if (!file) throw new Error('用法：bench <图片绝对路径>');
      const c = await start();
      try {
        const n = Number(values.n);
        const batch = c.batchSize;
        const batches = Math.ceil(n / batch);
        let roundtrip = 0;
        const t0 = performance.now();
        let next = 0;
        // 保持 3 个请求在途，下一批的预处理和本批推理重叠
        await Promise.all(
          Array.from({ length: 3 }, async () => {
            while (next < batches) {
              const b = next++;
              const size = Math.min(batch, n - b * batch);
              const t = performance.now();
              await c.tag(Array.from({ length: size }, (_, k) => ({ id: b * batch + k, path: file })), th);
              roundtrip += performance.now() - t;
            }
          }),
        );
        const secs = (performance.now() - t0) / 1000;
        log(`${n} 张用时 ${secs.toFixed(1)} 秒 → ${(n / secs).toFixed(2)} 张/秒（每批平均往返 ${(roundtrip / batches).toFixed(0)} ms）`);
      } finally {
        await c.dispose();
      }
      return;
    }
    default:
      console.log('用法：npm run tagger -w @emaki/server -- <download|inspect|tag|bench> [--model …] [--device dml|cpu] [--batch 8] [--n 64] [文件...]');
  }
}

main().catch((err) => {
  console.error(err instanceof TaggerCrashedError ? `TaggerCrashedError：${err.message}` : err);
  process.exitCode = 1;
});
