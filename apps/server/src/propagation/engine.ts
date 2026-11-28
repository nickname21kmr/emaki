/**
 * 引擎层的反应：排队（交给后台任务）和提交后（缓存、事件、监听者）。
 * 它们要碰的是进程里的东西（任务链、文件监听、设置监听、缓存），由引擎（SqliteDataSource）以 EngineHooks 的形式交进来；
 * 写操作不再自己调这些（附录 #16、#18、#20、#21、#22）。
 *
 * 只有用户和助手的操作会在这里直接拉起后台任务；后台任务自己写库时，后续任务由任务链（services/pipeline.ts）接着排。
 */
import type { EventBus } from '../core/events.ts';
import type { DomainChange, LibraryChangedReason } from '@emaki/shared';
import { changedReason, currentCall, isInteractive, type Actor } from './actor.ts';
import { cacheScope } from './cacheScope.ts';
import { ALL_CHANGES, publicChanges } from './changes.ts';
import type { Reaction } from './registry.ts';
import { markWork } from './work.ts';

export interface EngineHooks {
  /** 有图等着识别：模型在、用户没暂停时排一轮识别 */
  requestTag(): void;
  /** 有新图或文件内容变了：排缩略图（像素处理、dHash、帧数、相机） */
  requestThumbnails(): void;
  /** 有图改回了自动识别画师 */
  requestArtists(): void;
  /** 有新登记的 Pixiv 补充：设置里打开了自动补充才排（不清用户的暂停） */
  requestPixiv(): void;
  /** 这些图库文件夹里有重新显示的：查过重的话马上排一次查重（隐藏期间的查重删掉了它的未处理重复组） */
  requestDedupe(rootIds: number[]): void;
  /** 这些图库文件夹重新显示了：整个扫一遍（停用、移除期间的变化监听器收不到） */
  rescanRoots(rootIds: number[]): void;
  /** 有缓存的 Pixiv 投稿马上在本地重新匹配（不联网） */
  rematchPixiv(ids: number[]): Promise<unknown>;
  /** 设置变了：通知设置监听者 */
  settingsChanged(): void;
  /** 图库文件夹增删启停、漫画设置变了：通知监听者（文件监听据此调整） */
  rootsChanged(): void;
  /** 查询这些图里有没有等着识别的 */
  pendingTag(ids: number[]): boolean;
  /** 这些图里有没有等着识别画师的 */
  pendingArtists(ids: number[]): boolean;
  /** 有没有等着补充 Pixiv 的 */
  pendingPixiv(): boolean;
}

/** 后台任务写库时 changed 事件最多这么久推一次（扫描、识别以前各自节流，3 秒、5 秒） */
export const BACKGROUND_EMIT_MS = 3000;

/**
 * 对外的 changed 事件（附录 #36）：带这次提交变了哪些事实（公开的类型）、谁做的、哪个命令。
 * 用户和助手的操作马上推；后台任务按 reason 节流（首次马上推，之后最多 3 秒一次，最后一次补推，期间的类型合并），
 * 任务结束时马上推一次。推出去的事件 id 记进当前命令的上下文（命令层交给调用方）。
 */
export class ChangeEvents {
  private readonly last = new Map<LibraryChangedReason, number>();
  private readonly timers = new Map<LibraryChangedReason, NodeJS.Timeout>();
  /** 节流期间攒下的变化类型 */
  private readonly pending = new Map<LibraryChangedReason, { changes: Set<DomainChange>; actor: Actor }>();

  constructor(private readonly bus: EventBus) {}

  emit(actor: Actor, changes: readonly DomainChange[], throttle: boolean): void {
    const reason = changedReason(actor);
    if (!throttle) return void this.send(reason, actor, changes);
    const acc = this.pending.get(reason) ?? { changes: new Set<DomainChange>(), actor };
    for (const c of changes) acc.changes.add(c);
    this.pending.set(reason, acc);
    if (this.timers.has(reason)) return;
    const wait = (this.last.get(reason) ?? -Infinity) + BACKGROUND_EMIT_MS - performance.now();
    if (wait <= 0) return this.flushPending(reason);
    const t = setTimeout(() => {
      this.timers.delete(reason);
      this.flushPending(reason);
    }, wait);
    t.unref();
    this.timers.set(reason, t);
  }

  /** 马上推（任务结束时），取消等着的那次 */
  flush(reason: LibraryChangedReason, actor: Actor): void {
    clearTimeout(this.timers.get(reason));
    this.timers.delete(reason);
    const acc = this.pending.get(reason);
    this.pending.delete(reason);
    this.send(reason, acc?.actor ?? actor, [...(acc?.changes ?? [])]);
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private flushPending(reason: LibraryChangedReason): void {
    const acc = this.pending.get(reason);
    this.pending.delete(reason);
    if (acc) this.send(reason, acc.actor, [...acc.changes]);
  }

  private send(reason: LibraryChangedReason, actor: Actor, changes: readonly DomainChange[]): void {
    this.last.set(reason, performance.now());
    const call = currentCall();
    const command = call?.actor === actor ? call.command : undefined;
    const id = this.bus.publish({ type: 'changed', changes: [...changes], reason, actor, ...(command ? { command } : {}) });
    if (command) {
      call?.events?.push(id);
      for (const c of changes) call?.changes?.add(c);
    }
  }
}

export function engineReactions(hooks: EngineHooks, events: ChangeEvents): { queue: Reaction[]; after: Reaction[] } {
  const queue: Reaction[] = [
    {
      // 先排扫描：扫描优先级最高，但 io 道空着时先排上的先跑（查重要等扫描完再查）
      name: 'rescanRoots',
      on: ['root.visibilityChanged'],
      phase: 'queue',
      run({ changes, actor }) {
        if (isInteractive(actor)) hooks.rescanRoots([...new Set(changes.of('root.visibilityChanged').flatMap((c) => c.rootIds))]);
      },
    },
    {
      // 附录 #18：可见性、文件内容变了都要重新查重，标记持久化在库里（以前只在内存、只有图库文件夹变化会标）
      name: 'markDedupeDirty',
      on: [
        'image.added',
        'image.fileChanged',
        'image.gone',
        'image.returned',
        'image.trashed',
        'image.restored',
        // 动图只认文件完全相同（D5）：读到帧数后变成 / 不再是动图的图要重新比
        'image.animatedChanged',
        'visibility.changed',
        'root.visibilityChanged',
      ],
      phase: 'queue',
      run({ ctx, changes, actor }) {
        markWork(ctx.db, 'dedupe', new Date(ctx.clock()).toISOString());
        if (isInteractive(actor) && changes.has('root.visibilityChanged')) hooks.requestDedupe(changes.of('root.visibilityChanged').flatMap((c) => c.rootIds));
      },
    },
    {
      // 附录 #16：恢复排除、离开漫画文件夹、新入库的图，没识别过的接着识别
      name: 'queueTagging',
      on: ['visibility.changed', 'root.modeChanged', 'root.visibilityChanged', 'image.added', 'image.fileChanged', 'image.moved', 'image.returned'],
      phase: 'queue',
      run({ changes, actor }) {
        if (!isInteractive(actor)) return;
        const released = changes.of('visibility.changed').flatMap((c) => c.released);
        const ids = [...new Set([...released, ...changes.ids('root.modeChanged', 'image.added', 'image.fileChanged', 'image.moved', 'image.returned')])];
        if (hooks.pendingTag(ids)) hooks.requestTag();
      },
    },
    {
      name: 'queueAnalysis',
      on: ['image.added', 'image.fileChanged'],
      phase: 'queue',
      run({ actor }) {
        if (isInteractive(actor)) hooks.requestThumbnails();
      },
    },
    {
      // 改回自动画师（包括撤销手动改画师）：等着重新识别画师的接着识别
      name: 'queueArtists',
      on: ['curation.artistsChanged'],
      phase: 'queue',
      run({ changes, actor }) {
        if (isInteractive(actor) && hooks.pendingArtists(changes.ids())) hooks.requestArtists();
      },
    },
    {
      // 附录 #19：资格变了重新登记的 Pixiv 补充（queuePixivCheck 在事务里登记），打开了自动补充就排一轮
      name: 'schedulePixiv',
      on: [
        'image.sourceChanged',
        'image.kindChanged',
        'curation.shelvedChanged',
        'curation.originalChanged',
        'curation.charactersChanged',
        'visibility.changed',
        'root.modeChanged',
        'collections.changed',
      ],
      phase: 'queue',
      run({ actor }) {
        if (isInteractive(actor) && hooks.pendingPixiv()) hooks.requestPixiv();
      },
    },
    {
      // 附录 #13、#22：来源变了（包括撤销改识别方式），有缓存的投稿马上在本地重新匹配
      name: 'rematchCachedPixiv',
      on: ['image.sourceChanged'],
      phase: 'queue',
      run({ changes, actor }) {
        if (isInteractive(actor)) return hooks.rematchPixiv(changes.ids());
      },
    },
  ];
  const after: Reaction[] = [
    {
      name: 'notifySettings',
      on: ['settings.changed'],
      phase: 'after',
      run() {
        hooks.settingsChanged();
      },
    },
    {
      name: 'notifyRoots',
      on: ['root.visibilityChanged', 'root.modeChanged'],
      phase: 'after',
      run() {
        hooks.rootsChanged();
      },
    },
    {
      // 附录 #20、#21：缓存失效和事件只在这里。用户和助手强刷新，后台任务和启动修补弱刷新（旧结果最多再用 10 秒），事件节流。
      // 失效的范围看这次提交声明了哪些变化（cacheScope.ts）：收藏、分级、放下这类只清受影响的那几样，其余照旧全部清
      name: 'invalidateCaches',
      on: ALL_CHANGES,
      phase: 'after',
      always: true,
      run({ ctx, actor, all }) {
        const soft = !isInteractive(actor);
        ctx.invalidate(cacheScope(all.list), { soft });
        events.emit(actor, publicChanges(all.list), soft);
      },
    },
  ];
  return { queue, after };
}
