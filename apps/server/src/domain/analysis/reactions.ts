/**
 * 分析的反应 analyze（docs/core-architecture.md 第 5.2 节；P4a 起是分析在事务内的唯一入口，附录 #10、#23）。
 *
 * - 入库（image.added）：写上读文件头时拿到的帧数、相机，判类型；
 * - 文件内容变了（image.fileChanged，D1）：扫描发现外部改了文件、用户替换文件完全一样——清掉旧文件算出来的像素派生（缩略图任务按新文件重新生成），
 *   按新的尺寸、格式、帧数、相机重判类型；主题、画质分跟着「这份文件版本有没有识别结果」走（证据模块的反应先把识别标成过期，见 evidence/reactions.ts）；
 * - 图移动了（三条移动路径和扫描发现的移动一样）或者按漫画导入的设置变了：按新路径重判类型、漫画文件夹里的页按漫画判并去掉自动关联的角色。
 * 最终类型变了声明 image.kindChanged，是否动图变了声明 image.animatedChanged（D5：只有帧数、格式变了才会变，入库、换了文件）；
 * 去掉角色由归类模块声明 curation.charactersChanged（经 emit）。
 * 缩略图、识别这类昂贵的部分由提交后的排队反应交给后台任务（propagation/engine.ts）。
 */
import type { Db } from '../../db/connection.ts';
import type { Reaction } from '../../propagation/registry.ts';
import { analyze } from './analyze.ts';
import { backfillClassification } from './classify.ts';
import { syncRootModes } from './rootMode.ts';

const kinds = (db: Db, ids: number[]) => {
  const rows = db.prepare('SELECT id, content_kind AS kind FROM images WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as {
    id: number;
    kind: string;
  }[];
  return new Map(rows.map((r) => [r.id, r.kind]));
};

export const analyzeReaction: Reaction = {
  name: 'analyze',
  on: ['image.added', 'image.fileChanged', 'image.moved', 'root.modeChanged'],
  phase: 'tx',
  emits: ['image.kindChanged', 'image.animatedChanged', 'curation.charactersChanged'],
  run({ ctx, changes, emit }) {
    const db = ctx.db;
    const tx = { db, changed: emit };
    for (const c of changes.of('image.added')) analyze(tx, c.ids, { probes: c.probes, quiet: true });
    for (const c of changes.of('image.fileChanged')) analyze(tx, c.ids, { probes: c.probes, fileChanged: true });
    // 路径相关的部分：只知道「有图和设置对不上」（扫描结束时）就全库同步一遍，改了什么由全量的合集重算兜底
    const moved = changes.ids('image.moved');
    const ids = changes.ids('image.moved', 'root.modeChanged');
    if (changes.of('root.modeChanged').some((c) => !c.ids.length)) syncRootModes(db, undefined, emit);
    if (!ids.length) return;
    const before = kinds(db, ids);
    if (moved.length) backfillClassification(db, { ids: moved });
    syncRootModes(db, ids, emit);
    const after = kinds(db, ids);
    emit({ type: 'image.kindChanged', ids: ids.filter((id) => before.has(id) && after.get(id) !== before.get(id)) });
  },
};
