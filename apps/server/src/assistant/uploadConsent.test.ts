import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantService } from './service.ts';
import { CodexBackend } from './backends.ts';

const repo = path.resolve(import.meta.dirname, '../../../..');
const skill = path.join(repo, 'apps/server/assets/assistant/emaki-library');
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'emaki-consent-')); dirs.push(dir); return dir; };

it('系统指令：图库文件只读，上传图片前要用户同意', async () => {
  const service = new AssistantService(temp(), repo, () => 'http://localhost/api/assistant/mcp');
  service.store.settings.enabled = true; service.store.settings.backend = 'codex';
  const session = service.store.create();
  let instructions = '';
  vi.spyOn(CodexBackend, 'open').mockImplementation(async (_settings, _session, _cwd, _endpoint, text) => {
    instructions = text;
    return { models: async () => [], close: async () => {}, stop: async () => {} } as unknown as CodexBackend;
  });
  await service.models(session.id);
  expect(instructions).toContain('不要用 shell、脚本或直接 HTTP 请求移动、改名、删除或改写');
  expect(instructions).toContain('移到回收站');
  expect(instructions).toMatch(/上传到搜图网站.*ask_user.*完全访问等权限不等于同意/);
  await service.close();
});

it('查源参考：不主动上传，先征求同意，不推荐绕过代理', () => {
  const read = (file: string) => readFileSync(path.join(skill, file), 'utf8');
  const identify = read('references/identify-and-source.md');
  expect(identify).not.toContain('不等用户另说');
  expect(identify).toContain('上传前用 ask_user');
  expect(identify).toContain('不算同意');
  expect(identify).toMatch(/photo、screenshot.*questionable、explicit/);
  expect(read('references/yandex-http.md')).not.toMatch(/yandex-search\.py"[^\n]*--direct/);
  expect(read('references/batch-work.md')).toContain('上传图片到搜图网站不在此列');
  expect(read('SKILL.md')).toContain('图库里的图片文件只读');
});

// 没有可用的 Python（比如只有 Windows 商店占位）时跳过；EMAKI_TEST_PYTHON 可指定解释器
const python = [process.env.EMAKI_TEST_PYTHON, 'python', 'python3'].find(cmd =>
  cmd && spawnSync(cmd, ['-c', 'import sys; sys.exit(sys.version_info < (3, 8))'], { windowsHide: true }).status === 0);
const hasPillow = !!python && spawnSync(python, ['-c', 'import PIL'], { windowsHide: true }).status === 0;
// 只测生成查询图：requests/bs4 换成空模块，不联网；pil=0 时屏蔽 Pillow，走纯标准库
const harness = `
import importlib.util, json, sys, types
from pathlib import Path
script, pil, *pairs = sys.argv[1:]
for name in ("requests", "requests.adapters", "bs4", "urllib3", "urllib3.util", "urllib3.util.retry"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["requests.adapters"].HTTPAdapter = sys.modules["bs4"].BeautifulSoup = sys.modules["urllib3.util.retry"].Retry = None
if pil == "0":
    sys.modules["PIL"] = None
spec = importlib.util.spec_from_file_location("yandex_search", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = {}
for source, target in zip(pairs[::2], pairs[1::2]):
    try:
        data, mime, note = module.query_copy(Path(source))
        Path(target).write_bytes(data)
        result[Path(source).name] = mime
    except module.SearchError as error:
        result[Path(source).name] = error.status
print(json.dumps(result))
`;

describe.skipIf(!python)('yandex-search.py 只上传查询副本', () => {
  const exif = { IFD0: { Make: 'SECRET-CAMERA', ImageDescription: 'SECRET-DESC' } };
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/">SECRET-XMP</x:xmpmeta>';
  const base = (width = 64, height = 48) => sharp({ create: { width, height, channels: 3, background: '#c86432' } });
  async function fixtures(dir: string) {
    const jpeg = await base().jpeg().withExif(exif).withXmp(xmp).toBuffer();
    const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x10]), Buffer.from('SECRET-COMMENT')]);
    // 注释段加在开头，结束标记后面再接一段（像动态照片附带的视频）
    const files: Record<string, Buffer> = {
      'photo.jpg': Buffer.concat([jpeg.subarray(0, 2), comment, jpeg.subarray(2), Buffer.from('SECRET-TRAILER')]),
      // 扫描段前多出 4 字节，像常见的 pixiv 图那样（解码器只给警告）
      'pixiv.jpg': Buffer.concat([jpeg.subarray(0, jpeg.indexOf(Buffer.from([0xff, 0xda]))), Buffer.alloc(4), jpeg.subarray(jpeg.indexOf(Buffer.from([0xff, 0xda])))]),
      'webp.webp': await base().webp().withExif(exif).withXmp(xmp).toBuffer(),
      'anim.gif': await base().gif().toBuffer(),
    };
    // JFIF 头要留，紧跟一个 JFXX 扩展段（可以带缩略图）要去掉
    const jfif = Buffer.from('ffe000104a46494600010100000100010000', 'hex');
    const jfxxBody = Buffer.from('JFXX\0\x10SECRET-JFXX', 'latin1'), jfxx = Buffer.alloc(4); jfxx.writeUInt16BE(0xffe0); jfxx.writeUInt16BE(jfxxBody.length + 2, 2);
    files['jfxx.jpg'] = Buffer.concat([jpeg.subarray(0, 2), jfif, jfxx, jfxxBody, jpeg.subarray(2)]);
    // WebP：RIFF 范围内加一个私有块，RIFF 结束后再接一段附加数据
    const priv = Buffer.concat([Buffer.from('prVt'), Buffer.from([12, 0, 0, 0]), Buffer.from('SECRET-PRIV!')]);
    const riff = Buffer.concat([files['webp.webp']!, priv]); riff.writeUInt32LE(riff.length - 8, 4);
    files['extra.webp'] = Buffer.concat([riff, Buffer.from('SECRET-TRAILER')]);
    const png = await base().png().toBuffer(), text = Buffer.from('parameters\0SECRET-PROMPT');
    const chunk = Buffer.alloc(12 + text.length); chunk.writeUInt32BE(text.length); chunk.write('tEXt', 4); text.copy(chunk, 8);
    files['gen.png'] = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]); // 33 = 签名 + IHDR
    for (const [name, data] of Object.entries(files)) writeFileSync(path.join(dir, name), data);
    return Object.keys(files);
  }
  const run = (dir: string, names: string[], pil: '0' | '1') => {
    const pairs = names.flatMap(name => [path.join(dir, name), path.join(dir, `out-${name}`)]);
    // -B：不在技能目录里留 __pycache__（技能目录会整个复制进会话）
    const out = spawnSync(python!, ['-I', '-B', '-c', harness, path.join(skill, 'references/yandex-search.py'), pil, ...pairs], { encoding: 'utf8', windowsHide: true });
    expect(out.stderr).toBe('');
    return JSON.parse(out.stdout) as Record<string, string>;
  };
  const pixels = (data: Buffer) => sharp(data, { failOn: 'none' }).raw().toBuffer();

  it('没有 Pillow 时无损去掉元数据，像素不变；去不掉的格式拒绝', async () => {
    const dir = temp(), names = await fixtures(dir);
    expect(run(dir, names, '0')).toEqual({
      'photo.jpg': 'image/jpeg', 'pixiv.jpg': 'image/jpeg', 'webp.webp': 'image/webp', 'anim.gif': 'invalid_input',
      'jfxx.jpg': 'image/jpeg', 'extra.webp': 'image/webp', 'gen.png': 'image/png',
    });
    expect(readFileSync(path.join(dir, 'out-jfxx.jpg')).includes('JFIF\0')).toBe(true);
    for (const name of ['photo.jpg', 'pixiv.jpg', 'webp.webp', 'jfxx.jpg', 'extra.webp', 'gen.png']) {
      const original = readFileSync(path.join(dir, name)), copy = readFileSync(path.join(dir, `out-${name}`));
      expect(original.includes('SECRET'), name).toBe(true);
      expect(copy.includes('SECRET'), name).toBe(false);
      expect(copy.includes('Exif\0\0'), name).toBe(false);
      expect(await sharp(copy).metadata()).not.toHaveProperty('exif');
      expect((await pixels(copy)).equals(await pixels(original)), name).toBe(true);
    }
  });

  it.skipIf(!hasPillow)('有 Pillow 时重新编码成缩小的 JPEG', async () => {
    const dir = temp();
    writeFileSync(path.join(dir, 'big.png'), await base(2000, 1500).png().withExif(exif).toBuffer());
    writeFileSync(path.join(dir, 'big.jpg'), await base(1500, 2000).jpeg().withExif(exif).withXmp(xmp).toBuffer());
    expect(run(dir, ['big.png', 'big.jpg'], '1')).toEqual({ 'big.png': 'image/jpeg', 'big.jpg': 'image/jpeg' });
    for (const name of ['big.png', 'big.jpg']) {
      const copy = readFileSync(path.join(dir, `out-${name}`)), meta = await sharp(copy).metadata();
      expect(copy.includes('SECRET'), name).toBe(false);
      expect(Math.max(meta.width!, meta.height!)).toBe(1280);
      expect(meta).not.toHaveProperty('exif');
    }
  });
});
