/**
 * 合集的反应（docs/core-architecture.md 第 5.2 节 refreshFolderCollections / refreshPostGroups）。
 * 合集重算只在这里触发；写操作只声明变化（附录 #17：移动、撤回移动、整理到子文件夹、相机或帧数改了类型、
 * 让出或中止的任务、排除变化以前都会漏掉）。
 *
 * - 用户和助手的操作：事务内按 id 重算涉及的目录（refreshDirs）；
 * - 后台任务、启动修补：先记下「要全量重算」，任务结束（不论完成、让出还是取消）或启动完成时做一次 refreshAll；
 * - 图库文件夹启停、漫画设置变化：影响面不定，提交后全量重算（放在事务里会和撤销记录一起变慢）。
 * - 启动（library.opened）：合集判定的版本（DETECTOR_VERSION，记在 derived_versions 里）变了、或者上次延后的全量重算没做完
 *   （pending_work 里的 'collections'，进程中途退出时留下的）才全量重判（P4a，附录 #23：以前版本号存了从不检查，每次启动都无条件全量重算）。
 *   全量重判只按规则重判自动的合集；手动的合集（origin manual）、用户说「不成册」的（dismissed）不按判定增删，手动改过的字段保留。
 * 延后的全量重算持久化在 pending_work 里（defer 时记、做完清），重启不丢（第 7 节）。
 * EMAKI_COLLECTIONS=0 时都不做。
 */
import type { Db } from '../../db/connection.ts';
import { isInteractive } from '../../propagation/actor.ts';
import type { Propagation, Reaction } from '../../propagation/registry.ts';
import { isStale, markVersion } from '../../propagation/versions.ts';
import { clearWork, hasWork, markWork, peekWork } from '../../propagation/work.ts';
import type { CollectionService } from './CollectionService.ts';
import { DETECTOR_VERSION } from './detect.ts';

const enabled = () => process.env.EMAKI_COLLECTIONS !== '0';

/** 合集判定这种派生数据的版本（propagation/versions.ts） */
export const COLLECTIONS_DERIVED = { name: 'collections' as const, version: () => String(DETECTOR_VERSION) };

/** 启动时要不要全量重判：判定的版本变了，或者有没做完的延后重算 */
export function collectionsStale(db: Db): boolean {
  return isStale(db, COLLECTIONS_DERIVED) || hasWork(db, 'collections');
}

export function collectionReactions(service: CollectionService, propagation: Propagation, clock: () => number = Date.now): Reaction[] {
  const db = () => propagation.db;
  const now = () => new Date(clock()).toISOString();
  /** 全量重判，记下判定的版本，清掉开始之前的延后标记 */
  const refreshAll = () => {
    const seen = peekWork(db(), 'collections');
    const r = service.refreshAll();
    markVersion(db(), 'collections', COLLECTIONS_DERIVED.version(), now());
    clearWork(db(), 'collections', seen);
    return r;
  };
  propagation.onDeferred(
    'collections',
    () => {
      if (enabled()) refreshAll();
    },
    () => markWork(db(), 'collections', now()),
  );
  return [
    {
      name: 'refreshPostGroups',
      on: ['image.sourceChanged'],
      phase: 'tx',
      run({ ctx, changes, undo, actor, defer }) {
        if (!enabled()) return;
        // 后台任务（扫描重新解析来源）、启动修补：任务结束时的全量重算里也会重算同投稿组
        if (!isInteractive(actor)) return defer('collections');
        const ids = changes.ids();
        const json = JSON.stringify(ids);
        let before: Set<number> | null = null;
        if (undo) {
          // 撤销时要删掉这次新建的同投稿组、把成员的页码放回去：这些图、它们原来所在的组、新投稿号的组
          const affected = ctx.db
            .prepare(
              `SELECT id FROM images WHERE id IN (SELECT value FROM json_each(@ids))
                 OR collection_id IN (SELECT collection_id FROM images WHERE id IN (SELECT value FROM json_each(@ids)) AND collection_id IS NOT NULL)
                 OR source_site || ':' || source_post_id IN (SELECT source_site || ':' || source_post_id FROM images WHERE id IN (SELECT value FROM json_each(@ids)))`,
            )
            .pluck()
            .all({ ids: json }) as number[];
          undo.columns('images', ['collection_id', 'page_no', 'collection_detached'], affected);
          before = new Set(ctx.db.prepare('SELECT id FROM collections').pluck().all() as number[]);
        }
        service.refreshSources(ids);
        if (undo && before) for (const id of ctx.db.prepare('SELECT id FROM collections').pluck().all() as number[]) if (!before.has(id)) undo.inserted('collections', id);
      },
    },
    {
      name: 'refreshFolderCollections',
      on: [
        'image.added',
        'image.gone',
        'image.returned',
        'image.fileChanged',
        'image.moved',
        'image.trashed',
        'image.restored',
        'image.kindChanged',
        'visibility.changed',
        'evidence.changed',
      ],
      phase: 'tx',
      run({ changes, all, actor, defer }) {
        if (!enabled()) return;
        if (!isInteractive(actor)) return defer('collections');
        // 同一个事务里有文件夹级的变化：提交后会全量重算（refreshAllCollections），这里不再按目录算一遍
        // （两种算法新建合集的先后不同，撤销后合集编号会对不上）
        if (all.has('root.visibilityChanged', 'root.modeChanged', 'library.opened')) return;
        service.refreshDirs(changes.ids());
      },
    },
    {
      // 手动增删成员之后，涉及的合集（包括成员被挪走的那几本）按页序重新编号
      name: 'renumberCollections',
      on: ['collections.changed'],
      phase: 'tx',
      run({ changes }) {
        const ids = new Set(changes.of('collections.changed').flatMap((c) => c.collectionIds));
        for (const id of ids) service.assignPages(id);
      },
    },
    {
      name: 'refreshAllCollections',
      on: ['root.visibilityChanged', 'root.modeChanged', 'library.opened'],
      phase: 'after',
      run({ actor, defer, changes }) {
        if (!enabled()) return;
        if (actor.startsWith('job:')) return defer('collections');
        // 只是启动：版本没变、也没有没做完的延后重算时不全量重判（启动修补里延后的，启动完成时 flushDeferred 再做）
        if (!changes.has('root.visibilityChanged', 'root.modeChanged') && !collectionsStale(db())) return;
        const r = refreshAll();
        propagation.cancelDeferred('collections');
        if (actor === 'system:startup') console.log(`合集：${r.active} 本（新建 ${r.created} · 删除 ${r.removed} · 更新 ${r.updated}）· ${Math.round(r.ms)} ms`);
      },
    },
  ];
}
