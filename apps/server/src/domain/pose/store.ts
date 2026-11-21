/**
 * 姿势模块的写入（pose_classes、image_poses 只在这里写，test/architecture/owners.ts）。
 * 调用方在事务里调用；写完由调用方声明 pose.changed。
 */
import type { Db } from '../../db/connection.ts';
import type { PoseAsset } from './asset.ts';
import { packMedoid, packPerson, type Group, type Person } from './features.ts';

/**
 * 提取和归类的版本：检测、筛选或类别的规则改了就加 1。
 * 旧版本的行照常能用（找图、相近的图都看它），只是标成「旧的」：大图库重跑要很久，不自动重跑，
 * 用户在设置里点「用新的找人模型重新提取」（pose.reextract）才重跑。
 * 1 = YOLOX-L 找人（原型 keypoints_lib.npz 也是它）；2 = deepghs 动漫人物检测（person_detect_v1.1_m，2026-11-21）
 */
export const POSE_VERSION = 2;
/** YOLOX 那一版（导入原型数据时用） */
export const POSE_VERSION_YOLOX = 1;

/** 把随仓库分发的类别同步进库（版本或类别变了才写）；返回有没有写 */
export function syncPoseClasses(db: Db, asset: PoseAsset, figure: (file: string) => Buffer): boolean {
  const have = db.prepare('SELECT id, version FROM pose_classes').all() as { id: string; version: number }[];
  const ids = new Set(asset.classes.map((c) => c.id));
  if (have.length === asset.classes.length && have.every((r) => r.version === asset.version && ids.has(r.id))) return false;
  const upsert = db.prepare(
    `INSERT INTO pose_classes (id, grp, name, description, sort, medoid, cut, figure, version)
     VALUES (@id, @grp, @name, @description, @sort, @medoid, @cut, @figure, @version)
     ON CONFLICT(id) DO UPDATE SET grp = excluded.grp, name = excluded.name, description = excluded.description, sort = excluded.sort,
       medoid = excluded.medoid, cut = excluded.cut, figure = excluded.figure, version = excluded.version`,
  );
  db.transaction(() => {
    asset.classes.forEach((c, i) =>
      upsert.run({
        id: c.id,
        grp: c.group,
        name: c.name,
        description: c.description,
        sort: i,
        medoid: packMedoid(c.medoid.kp, c.medoid.ks),
        cut: c.cut,
        figure: figure(c.figure),
        version: asset.version,
      }),
    );
    const del = db.prepare('DELETE FROM pose_classes WHERE id = ?');
    for (const r of have) if (!ids.has(r.id)) del.run(r.id);
  })();
  return true;
}

export interface PoseRow {
  imageId: number;
  status: string;
  group: Group | null;
  /** 主要人物（屏蔽过的置信度）和检测时的尺寸；没有可用人物是 null */
  person: { person: Person; w: number; h: number } | null;
  classId: string | null;
  nearestId: string | null;
  distance: number | null;
  mirror: boolean;
}

/** 写一批图的姿势（替换旧的）。必须在事务里调用 */
export function writePoses(db: Db, rows: readonly PoseRow[], now: string, version = POSE_VERSION): void {
  const st = db.prepare(
    `INSERT INTO image_poses (image_id, status, grp, keypoints, class_id, nearest_id, distance, mirror, version, updated_at)
     VALUES (@imageId, @status, @grp, @keypoints, @classId, @nearestId, @distance, @mirror, @version, @now)
     ON CONFLICT(image_id) DO UPDATE SET status = excluded.status, grp = excluded.grp, keypoints = excluded.keypoints,
       class_id = excluded.class_id, nearest_id = excluded.nearest_id, distance = excluded.distance, mirror = excluded.mirror,
       version = excluded.version, updated_at = excluded.updated_at`,
  );
  for (const r of rows)
    st.run({
      imageId: r.imageId,
      status: r.status,
      grp: r.group,
      keypoints: r.person ? packPerson(r.person.person, r.person.w, r.person.h) : null,
      classId: r.classId,
      nearestId: r.nearestId,
      distance: r.distance,
      mirror: r.mirror ? 1 : 0,
      version,
      now,
    });
}

/** 每一类在本图库里有多少张（全部行，不看可见性；界面上的数按口径现算，见 read.ts） */
export function refreshClassSizes(db: Db): void {
  db.prepare('UPDATE pose_classes SET size = (SELECT COUNT(*) FROM image_poses p WHERE p.class_id = pose_classes.id)').run();
}

/** 原型里的代表图（导入原型数据时，这张图也在本图库里才记） */
export function setMedoidImages(db: Db, medoids: ReadonlyMap<string, number>): void {
  const st = db.prepare('UPDATE pose_classes SET medoid_image_id = (SELECT id FROM images WHERE id = @img) WHERE id = @id');
  for (const [id, img] of medoids) st.run({ id, img });
}
