import { ArrowUpRight } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { useScrollContainer } from '@/components/layout/ScrollContainer';
import { Skeleton } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { useHotkey } from '@/lib/hotkeys';
import { useStats } from '@/lib/queries';
import { useOverlays, usePrefs } from '@/lib/stores';
import { CustomMatchPill } from './overview/CustomMatchPill';
import { FlatCharacters } from './overview/FlatCharacters';
import { NewCharacterDialog } from './overview/NewCharacterDialog';
import { OverviewRecent } from './overview/OverviewRecent';
import { useCharactersParams, type WorkScope } from './overview/params';
import { SearchBar } from './overview/SearchBar';
import { TopBento } from './overview/TopBento';
import { WorkChips } from './overview/WorkChips';
import { WorksShelf } from './overview/WorksShelf';
import { useWorkIndex } from './overview/works';
import { EASE_OUT } from '@/lib/motion';

const EASE = EASE_OUT;

/** 选中作品时，角色少于这个数就不单独做 Bento（下面的书架已经一眼看全了） */
const BENTO_MIN_CHARACTERS = 5;

/**
 * 角色页（核心页面）。
 *
 *   头部：标题 + 统计 · 自建角色提示胶囊 · 全局操作
 *         搜索框 ——————————————— 书架 / 列表
 *         总览 · 最近在收 · 作品 chip…… | 全部作品 ⌄
 *   总览（没选作品、没搜索）：你最常看的（Bento）→ 最近 30 天在收（没有就「更多常看的」）→ 作品扇形网格（T30）
 *   选了作品 / 搜索 / 列表视图：你最常看的 + 全部角色（书架 / 列表，无限滚动）
 *
 * 筛选状态都在 URL 里（见 overview/params.ts）。
 * 快捷键：Ctrl/⌘+F 聚焦搜索 · V 切换书架/列表 · [ ] 切换作品 · N 新建角色
 */
export function CharactersPage() {
  const params = useCharactersParams();
  const { work, qTrimmed, source, sort } = params;
  const { data: stats } = useStats();
  const { byId } = useWorkIndex();
  const view = usePrefs((s) => s.charactersView);
  const setView = usePrefs((s) => s.setCharactersView);
  const overlayOpen = useOverlays((s) => s.commandOpen || s.helpOpen);
  const scrollRef = useScrollContainer();
  const searchRef = useRef<HTMLInputElement>(null);

  // ---------------------------------------------------------------- 新建角色
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState<string | undefined>();
  const openCreate = useCallback((name?: string) => {
    setCreateName(name);
    setCreateOpen(true);
  }, []);

  // ---------------------------------------------------------------- 快捷键
  const hotkeysEnabled = !createOpen && !overlayOpen;
  useHotkey(
    'mod+f',
    () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    { enabled: hotkeysEnabled },
  );
  useHotkey('v', () => setView(view === 'shelf' ? 'list' : 'shelf'), { enabled: hotkeysEnabled });
  useHotkey('n', () => openCreate(qTrimmed || undefined), { enabled: hotkeysEnabled });

  // ---------------------------------------------------------------- 作用域
  const selectWork = useCallback(
    (v: WorkScope, scrollTop = false) => {
      params.setWork(v);
      if (scrollTop) scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [params, scrollRef],
  );

  const workObj = work && work !== 'recent' ? byId.get(work) : undefined;
  const filtered = !!qTrimmed || !!source;
  // 作品还没加载出来时先乐观地显示 Bento 骨架，免得加载完再「长」出来
  const showBento = !filtered && (!workObj || workObj.characterCount >= BENTO_MIN_CHARACTERS);
  // 总览：Top → 最近在收 → 作品扇形网格；列表视图就是「按角色看全部」
  const overview = work === null && !filtered && view === 'shelf';

  // 切作品 / 切自建时整块内容换 key 重新挂载并淡入；搜索词变化不换（旧结果变淡即可）
  const scopeKey = `${work ?? 'all'}|${source ?? ''}`;
  useScrollMemory(scrollRef, `${scopeKey}|${view}`);

  return (
    <>
      <PageHeader
        sticky
        title="角色"
        subtitle={
          stats ? (
            `${formatCount(stats.characterCount)} 位角色 · ${formatCount(stats.workCount)} 部作品`
          ) : (
            <Skeleton className="h-3.5 w-40" />
          )
        }
        actions={
          <CustomMatchPill
            count={stats?.customMatchableCount ?? 0}
            active={source === 'custom'}
            onToggle={() => params.setSource(source === 'custom' ? undefined : 'custom')}
          />
        }
      >
        <SearchBar q={params.q} onCommit={params.setQ} view={view} onViewChange={setView} inputRef={searchRef} />
        <div className="mt-4">
          <WorkChips selected={work} onSelect={(v) => selectWork(v)} hotkeysEnabled={hotkeysEnabled} />
        </div>
      </PageHeader>

      <PageBody className="pt-4">
        <motion.div
          key={scopeKey}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
        >
          {/* 总览的列表视图 = 按角色看全部，不需要 Top */}
          {showBento && !(work === null && !filtered && view === 'list') && (
            <div className={overview ? 'mb-10' : 'mb-8'}>
              <TopBento
                workId={work}
                byId={byId}
                title="你最常看的"
                hint={
                  work === 'recent'
                    ? '最近 30 天有新图 · 按收藏张数'
                    : workObj
                      ? `${workObj.name} · 按收藏张数`
                      : '按收藏张数'
                }
                actions={
                  workObj ? (
                    <Link
                      to={`/works/${workObj.id}`}
                      className="group/link inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                    >
                      作品页
                      <ArrowUpRight className="size-3.5 transition-transform duration-300 group-hover/link:translate-x-px group-hover/link:-translate-y-px" />
                    </Link>
                  ) : undefined
                }
              />
            </div>
          )}

          <motion.div
            key={view}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            {overview ? (
              <div className="space-y-10">
                <OverviewRecent byId={byId} onSeeAll={() => selectWork('recent', true)} />
                <WorksShelf
                  onPick={(id) => selectWork(id, true)}
                  onCreate={() => openCreate()}
                  onShowAll={() => {
                    setView('list');
                    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                />
              </div>
            ) : (
              <FlatCharacters
                view={view}
                work={work}
                q={qTrimmed}
                sort={sort}
                source={source}
                byId={byId}
                customMatchable={stats?.customMatchableCount ?? 0}
                onSortChange={(v) => params.setSort(v, work)}
                onClearQuery={() => params.setQ('')}
                onClearSource={() => params.setSource(undefined)}
                onCreate={openCreate}
              />
            )}
          </motion.div>
        </motion.div>
      </PageBody>

      <NewCharacterDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialName={createName}
        initialWorkId={workObj?.id}
      />
    </>
  );
}

/**
 * 按作用域记住滚动位置（MS-5）：从某部作品回到总览、浏览器后退时，回到原来的位置。
 * 存在 sessionStorage（读写都可能抛错，比如隐私模式），等淡入动画结束再恢复。
 */
function useScrollMemory(scrollRef: React.RefObject<HTMLDivElement | null>, key: string) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const storageKey = `emaki:chars-scroll:${key}`;
    let saved = 0;
    try {
      saved = Number(sessionStorage.getItem(storageKey) ?? 0);
    } catch {
      /* 读不到就不恢复 */
    }
    const t = saved > 0 ? window.setTimeout(() => el.scrollTo({ top: saved }), 450) : undefined;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try {
          sessionStorage.setItem(storageKey, String(Math.round(el.scrollTop)));
        } catch {
          /* 写不进去就算了 */
        }
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.clearTimeout(t);
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef, key]);
}
