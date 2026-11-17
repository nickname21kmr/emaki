/**
 * 分析的反应：路径相关的分类（docs/core-architecture.md 第 5.2 节 analyze 的「事务内做便宜的部分」）。
 *
 * 图移动了（三条移动路径一样）或者按漫画导入的设置变了：按新路径重判类型、漫画文件夹里的页按漫画判并去掉自动关联的角色。
 * 最终类型变了声明 image.kindChanged；去掉角色由归类模块声明 curation.charactersChanged（经 emit）。
 * 缩略图、识别这类昂贵的部分由提交后的排队反应交给后台任务（propagation/engine.ts）。
 * 统一「文件内容变化」的语义、analyze 唯一入口是 P4 的事（D1）。
 */
import type { Db } from '../../db/connection.ts';
import { backfillClassification } from '../../services/classify/backfill.ts';
import { syncRootModes } from '../../services/classify/rootMode.ts';
import type { Reaction } from '../../propagation/registry.ts';

const kinds = (db: Db, ids: number[]) =>
  new Map(
    (db.prepare('SELECT id, content_kind AS kind FROM images WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as { id: number; kind: string }[]).map(
      (r) => [r.id, r.kind],
    ),
  );

export const reclassifyByPathReaction: Reaction = {
  name: 'reclassifyByPath',
  on: ['image.moved', 'root.modeChanged'],
  phase: 'tx',
  emits: ['image.kindChanged', 'curation.charactersChanged'],
  run({ ctx, changes, emit }) {
    const db = ctx.db;
    const moved = changes.ids('image.moved');
    const ids = changes.ids();
    // 只知道「有图和设置对不上」（扫描结束时）：全库同步一遍，改了什么由全量的合集重算兜底
    if (changes.of('root.modeChanged').some((c) => !c.ids.length)) syncRootModes(db, undefined, emit);
    if (!ids.length) return;
    const before = kinds(db, ids);
    if (moved.length) backfillClassification(db, { ids: moved });
    syncRootModes(db, ids, emit);
    const after = kinds(db, ids);
    emit({ type: 'image.kindChanged', ids: ids.filter((id) => before.has(id) && after.get(id) !== before.get(id)) });
  },
};
