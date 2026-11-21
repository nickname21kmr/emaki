/**
 * 演示模式的假部件（infra/ports.ts 的 EnginePorts）：
 * - 图片文件：按演示数据生成 SVG 占位图（placeholder.ts），不读磁盘；
 * - 后台任务：只走进度条，不扫描、不跑识别模型、不联网、不改数据；
 * - 回收站：只记录，不碰文件；
 * - 用户的图库文件夹：一律不碰（移动、导入、替换等直接拒绝）。
 */
import type { JobKind, ThumbWidth } from '@emaki/shared';
import type { JobRunner } from '../core/jobs.ts';
import type { FileResponse } from '../infra/ports.ts';
import type { EnginePorts, ImageFileRow, ImageFilesPort } from '../infra/ports.ts';
import type { DemoDb } from './fixtures.ts';
import { placeholderSvg } from './placeholder.ts';
import type { IdMap } from './seed.ts';

/** 占位图的样子：随机种子（重复组里的副本沿用原图的种子，看起来像同一张图）和色相 */
interface Look {
  seed: string;
  hue: number;
}

/** 主色 #rrggbb 的色相（演示数据之外的图没有 hue，就从主色推一个） */
function hueOf(hex: string | null): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!m) return 210;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(h * 60 + 360) % 360;
}

/** 图片文件部件：缩略图和原图都是 SVG 占位图 */
export class PlaceholderImages implements ImageFilesPort {
  private readonly looks = new Map<number, Look>();

  /** 灌完数据后登记每张图的样子 */
  register(demo: DemoDb, map: IdMap): void {
    for (const img of demo.images.values()) {
      const id = map.images.get(img.id);
      if (id !== undefined) this.looks.set(id, { seed: img.seed, hue: img.hue });
    }
  }

  private look(row: ImageFileRow): Look {
    return this.looks.get(row.id) ?? { seed: row.sha256, hue: hueOf(row.dominant_color) };
  }

  async thumbnail(row: ImageFileRow, width: ThumbWidth): Promise<FileResponse> {
    const { seed, hue } = this.look(row);
    return {
      kind: 'buffer',
      contentType: 'image/svg+xml',
      body: placeholderSvg({ id: seed, width: row.width, height: row.height, hue, outWidth: width }),
    };
  }

  async original(row: ImageFileRow): Promise<FileResponse> {
    const { seed, hue } = this.look(row);
    return {
      kind: 'buffer',
      contentType: 'image/svg+xml',
      body: placeholderSvg({ id: seed, width: row.width, height: row.height, hue, outWidth: 1600, label: row.file_name }),
    };
  }
}

/** 假任务的「工作量」：只用来画进度条 */
const FAKE_TOTALS: Record<JobKind, number> = {
  scan: 1800,
  thumbnail: 600,
  tag: 240,
  'danbooru-sync': 120,
  'pixiv-tags': 60,
  artists: 120,
  dedupe: 900,
  pose: 300,
  'pose-tags': 300,
  'pose-match': 300,
};

/** 后台任务部件：每种任务都只走一遍进度条（约 5 秒），不扫描、不跑模型、不联网、不改数据 */
export function simulatedJob(kind: JobKind, stepMs = 80): JobRunner {
  return async (ctx) => {
    const total = FAKE_TOTALS[kind];
    ctx.setTotal(total);
    const step = Math.max(1, Math.round(total / 60));
    for (let done = 0; done < total && !ctx.signal.aborted; done += step) {
      await new Promise((r) => setTimeout(r, stepMs));
      ctx.advance(Math.min(step, total - done), `${Math.min(done + step, total)} / ${total}`);
    }
    return '演示数据：只模拟了进度，没有真的扫描、识别或联网';
  };
}

export interface DemoPorts extends EnginePorts {
  imageFiles: PlaceholderImages;
  /** 演示里「移到系统回收站」记下的路径（不碰文件） */
  readonly trashed: string[];
}

/** 演示模式的全部部件；jobStepMs 是假任务每一步的间隔（测试里调小） */
export function demoPorts(clock: () => number = Date.now, jobStepMs = 80): DemoPorts {
  const trashed: string[] = [];
  return {
    clock,
    trashImpl: async (paths) => void trashed.push(...paths),
    checkRecyclable: async () => {},
    imageFiles: new PlaceholderImages(),
    libraryFiles: false,
    jobRunner: (kind) => simulatedJob(kind, jobStepMs),
    // 演示不跑姿势模型（假任务只走进度条）
    poseDetector: null,
    autoJobs: false,
    // 词库导入会按词库改角色的显示名（演示数据里的名字是写好的），也要多花约 1 秒：不导入
    importDict: false,
    // 局域网入口用真实网络：默认关着，手动打开后可以拿假手机脚本（scripts/lan-client.ts）对着演示数据走一遍
    lan: null,
    trashed,
  };
}
