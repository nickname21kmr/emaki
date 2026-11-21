/**
 * 导入原型（F:/Claude/.work/pose-proto）跑好的姿势数据：keypoints_lib.npz（每张图检测到的全部人物）+ assignments.json（原型的归类）。
 * 一次性的，同样的文件再导一次结果不变。只导本图库里还有的图（id 对不上的跳过）；原型没处理过的（not_processed、读不了的）
 * 不写，留给「提取姿势」任务。主要人物按 TypeScript 版重新挑（和原型一致率见 domain/pose/features.test.ts），类别、距离、镜像照原型的。
 * 原型的 keypoints_lib.npz 是 YOLOX 找人跑的，记成旧版本（POSE_VERSION_YOLOX）；已经按新版本提取过的图不覆盖。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { SqliteContext } from '../../datasource/sqlite/context.ts';
import { loadPoseAsset } from '../../domain/pose/asset.ts';
import { selectPerson, type DetectedPerson, type Group, type Pt } from '../../domain/pose/features.ts';
import { POSE_VERSION, POSE_VERSION_YOLOX, refreshClassSizes, setMedoidImages, writePoses, type PoseRow } from '../../domain/pose/store.ts';
import { readNpz, type NpyArray } from '../../infra/npz.ts';
import { ensurePoseClasses } from './job.ts';

interface ProtoAssignment {
  class: string;
  rep?: number;
  group?: string;
  distance?: number | null;
  nearest_class?: string | null;
  reason?: string | null;
  mirror?: boolean;
}

export interface ProtoImportResult {
  /** 写进 image_poses 的图 */
  imported: number;
  /** 其中归了类的 */
  classified: number;
  /** 本图库里没有的图 */
  missing: number;
  /** 原型没处理过（留给任务），或者已经用新的找人模型提取过 */
  skipped: number;
}

/** 原型目录：开发机上两个文件都在，就给「导入已有的姿势数据」做默认值 */
const PROTO_CANDIDATES = [
  { keypointsPath: 'F:/Claude/.work/pose-proto/cache/keypoints_lib.npz', assignmentsPath: 'F:/Claude/.work/pose-proto/out/full_run/assignments.json' },
];

export function localPrototype(): { keypointsPath: string; assignmentsPath: string } | null {
  return PROTO_CANDIDATES.find((c) => existsSync(c.keypointsPath) && existsSync(c.assignmentsPath)) ?? null;
}

const num = (a: NpyArray, i: number) => Number(a.data[i]!);

export async function importPrototype(ctx: SqliteContext, keypointsPath: string, assignmentsPath: string): Promise<ProtoImportResult> {
  const asg = JSON.parse(await readFile(assignmentsPath, 'utf8')) as Record<string, ProtoAssignment>;
  const z = readNpz(await readFile(keypointsPath));
  const need = ['img_id', 'img_w', 'img_h', 'img_err', 'img_start', 'img_count', 'p_box', 'p_score', 'p_fallback', 'p_kp', 'p_ks'];
  for (const k of need) if (!z.has(k)) throw new Error(`${keypointsPath} 里没有 ${k}（不是原型的 keypoints_lib.npz？）`);
  const A = Object.fromEntries(need.map((k) => [k, z.get(k)!])) as Record<string, NpyArray>;
  const nkp = A.p_kp!.shape[1]!;
  const row = new Map<number, number>();
  for (let i = 0; i < A.img_id!.data.length; i++) row.set(num(A.img_id!, i), i);
  const persons = (n: number): DetectedPerson[] => {
    const s = num(A.img_start!, n);
    const c = num(A.img_count!, n);
    const out: DetectedPerson[] = [];
    for (let j = s; j < s + c; j++) {
      const kp: Pt[] = [];
      const ks: number[] = [];
      for (let k = 0; k < 23; k++) {
        kp.push([Number(A.p_kp!.data[(j * nkp + k) * 2]), Number(A.p_kp!.data[(j * nkp + k) * 2 + 1])]);
        ks.push(Number(A.p_ks!.data[j * nkp + k]));
      }
      const b = [0, 1, 2, 3].map((q) => Number(A.p_box!.data[j * 4 + q])) as [number, number, number, number];
      out.push({ box: b, score: num(A.p_score!, j), fallback: !!A.p_fallback!.data[j], kp, ks });
    }
    return out;
  };

  ensurePoseClasses(ctx);
  const db = ctx.db;
  const known = new Set(db.prepare('SELECT id FROM pose_classes').pluck().all() as string[]);
  const ids = Object.keys(asg).map(Number).filter(Number.isInteger);
  const exists = new Set(db.prepare('SELECT id FROM images WHERE id IN (SELECT value FROM json_each(?))').pluck().all(JSON.stringify(ids)) as number[]);
  // 已经用新的找人模型提取过的图：原型的旧结果不盖上去
  const fresh = new Set(db.prepare('SELECT image_id FROM image_poses WHERE version >= ?').pluck().all(POSE_VERSION) as number[]);
  const rows: PoseRow[] = [];
  let skipped = 0;
  for (const id of ids) {
    if (!exists.has(id)) continue;
    if (fresh.has(id)) {
      skipped++;
      continue;
    }
    const a = asg[String(id)]!;
    const n = row.get(a.rep ?? id);
    if (n === undefined || num(A.img_err!, n)) {
      skipped++;
      continue;
    }
    const w = num(A.img_w!, n);
    const h = num(A.img_h!, n);
    const sel = selectPerson(persons(n), w, h);
    const classId = a.class !== 'unclassified' && known.has(a.class) ? a.class : null;
    const nearestId = a.nearest_class && known.has(a.nearest_class) ? a.nearest_class : null;
    rows.push({
      imageId: id,
      status: classId ? 'ok' : (a.reason ?? 'unclassified'),
      group: (a.group as Group | undefined) ?? (sel.ok ? sel.group : null),
      person: sel.ok ? { person: sel.person, w, h } : null,
      classId,
      nearestId,
      distance: a.distance ?? null,
      mirror: !!a.mirror,
    });
  }
  const now = new Date(ctx.clock()).toISOString();
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    ctx.apply(() => {
      writePoses(db, chunk, now, POSE_VERSION_YOLOX);
      ctx.changed({ type: 'pose.changed', ids: chunk.map((r) => r.imageId) });
    });
  }
  ctx.apply(() => {
    setMedoidImages(db, new Map(loadPoseAsset().classes.map((c) => [c.id, c.medoidImageId])));
    refreshClassSizes(db);
  });
  return { imported: rows.length, classified: rows.filter((r) => r.classId).length, missing: ids.length - exists.size, skipped };
}
