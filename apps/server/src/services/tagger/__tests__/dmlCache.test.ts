/**
 * DirectML 适配器缓存（dml-device.json）：缓存的适配器失效时删掉，下次重新探测。不起子进程。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTmpDir } from '../../../../test/helpers/tmp.ts';
import { startTagger, TaggerClient, type TaggerStartOptions } from '../client.ts';
import type { ReadyMsg } from '../protocol.ts';

const PIXAI_FP16 = 'A1yCE/pixai-tagger-v1.0-onnx-fp16';
const PIXAI_WEBGPU = 'noaione/pixai-tagger-v1.0-onnx';
const WD = 'SmilingWolf/wd-eva02-large-tagger-v3';

/** 假的 spawn：按请求的适配器决定子进程落在哪 */
function stubSpawn(
  land: (o: TaggerStartOptions & { dmlDeviceId: number | 'probe' }) => { device: ReadyMsg['device']; dmlDeviceId: number | null },
) {
  return vi.spyOn(TaggerClient, 'spawn').mockImplementation(async (o) => {
    const r = land(o);
    const info: ReadyMsg = {
      type: 'ready',
      ...r,
      fallbackReason: null,
      batchSize: 1,
      fixedBatch: false,
      inputName: 'input',
      inputShape: [],
      outputName: 'output',
      numLabels: 0,
      loadMs: 0,
      pid: 1,
    };
    return { info, device: r.device } as unknown as TaggerClient;
  });
}

describe('startTagger 的适配器缓存', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const setup = (repo: string, cached: number | null) => {
    const modelsDir = makeTmpDir('dml-cache');
    dirs.push(modelsDir);
    const file = path.join(modelsDir, 'dml-device.json');
    if (cached !== null) writeFileSync(file, JSON.stringify({ deviceId: cached }));
    const opts: TaggerStartOptions = { repo, modelPath: 'm', labelsPath: 'l', device: 'dml', batchSize: 1, modelsDir };
    return { file, opts };
  };

  it('缓存的适配器起不来、子进程改走 WebGPU：删掉缓存，下次重新探测并记下新的', async () => {
    const { file, opts } = setup(PIXAI_FP16, 3);
    const spawn = stubSpawn((o) =>
      o.dmlDeviceId === 'probe' ? { device: 'dml', dmlDeviceId: 1 } : { device: 'webgpu', dmlDeviceId: null },
    );
    expect((await startTagger(opts)).info.device).toBe('webgpu');
    expect(existsSync(file)).toBe(false);
    expect((await startTagger(opts)).info.device).toBe('dml');
    expect(spawn.mock.calls.map((c) => c[0].dmlDeviceId)).toEqual([3, 'probe']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ deviceId: 1 });
  });

  it('落到 CPU 也删', async () => {
    const { file, opts } = setup(WD, 2);
    stubSpawn(() => ({ device: 'cpu', dmlDeviceId: null }));
    await startTagger(opts);
    expect(existsSync(file)).toBe(false);
  });

  it('没试 DirectML 的（主动要求走 WebGPU、只能走 WebGPU 的模型）不动缓存', async () => {
    stubSpawn(() => ({ device: 'webgpu', dmlDeviceId: null }));
    const a = setup(PIXAI_FP16, 0);
    await startTagger({ ...a.opts, noDml: true });
    expect(existsSync(a.file)).toBe(true);
    const b = setup(PIXAI_WEBGPU, 0);
    await startTagger(b.opts);
    expect(existsSync(b.file)).toBe(true);
  });

  it('缓存的适配器能用：不动', async () => {
    const { file, opts } = setup(PIXAI_FP16, 0);
    stubSpawn((o) => ({ device: 'dml', dmlDeviceId: o.dmlDeviceId as number }));
    await startTagger(opts);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ deviceId: 0 });
  });
});
