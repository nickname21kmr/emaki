import type { LibraryRoot, LibraryRootMode, Rating, UpdateLibraryRootBody } from '@emaki/shared';
import { BookOpen, ChevronDown, FolderInput, FolderOpen, FolderSearch, FolderX, Trash } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Badge, Button, IconButton, Input, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, Segmented, Switch } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatCount, formatDateTime, formatPercent, formatRelative, RATING_LABEL } from '@/lib/format';
import { errorMessage, useMutate } from '@/lib/queries';
import { useRemoveRoot, useUpdateRoot } from '../hooks';
import { EASE_OUT } from '@/lib/motion';

/**
 * 图库文件夹的添加表单与列表。设置页「图库文件夹」一节和首次使用引导共用。
 */

// 盘符（D:\ 或 D:/）、UNC 网络路径（\\NAS\…）、Unix 绝对路径（/…）
const ABSOLUTE = /^(?:[a-zA-Z]:(?:[\\/]|$)|\\\\[^\\]|\/)/;

// 资源管理器「复制为路径」会带引号
const unquote = (p: string) =>
  p
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();

// 和后端一样把反斜杠统一成 /、去掉结尾的 /；Windows 路径不区分大小写
const normalize = (p: string) =>
  unquote(p)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

/**
 * 输入框 + 「浏览…」（后端弹出系统选择对话框）+ 提交。
 * 错误（重复、相对路径、后端 400）显示在输入框下方，不弹 toast。
 * actions 由调用方决定：弹窗里是「取消 / 添加并扫描」，引导页里是一个「添加」。
 */
export function AddFolderForm({
  roots,
  onDone,
  autoFocus,
  actions,
}: {
  roots: LibraryRoot[];
  onDone?: () => void;
  autoFocus?: boolean;
  actions: (state: { disabled: boolean; loading: boolean }) => ReactNode;
}) {
  const [path, setPath] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  // 新文件夹包含已有的文件夹：后端返回要问的话，确认后带 merge 重发
  const [confirm, setConfirm] = useState<{ path: string; question: string; mode: LibraryRootMode; comicRating: Rating } | null>(null);
  const [picking, setPicking] = useState(false);
  // 导入方式：插画（识别角色）/ 漫画（跳过识别，每个子文件夹一本）；漫画要先选分级（不识别就不知道）
  const [mode, setMode] = useState<LibraryRootMode>('auto');
  const [comicRating, setComicRating] = useState<Rating>('general');
  // 这次发出去的路径和导入方式：要确认合并时照原样重发
  const lastSend = useRef<{ path: string; mode: LibraryRootMode; comicRating: Rating }>({ path: '', mode: 'auto', comicRating: 'general' });
  const add = useMutate(
    (v: { p: string; merge?: boolean; mode: LibraryRootMode; comicRating: Rating }) =>
      api.addLibraryRoot({ path: v.p, merge: v.merge, mode: v.mode, comicRating: v.comicRating }),
    {
      onError: (message, err) => {
        if (err instanceof ApiRequestError && err.code === 'needs_confirm') setConfirm({ ...lastSend.current, question: message });
        else setServerError(message);
      },
      onSuccess: () => {
        setPath('');
        setConfirm(null);
        onDone?.();
      },
    },
  );

  const trimmed = unquote(path);
  const duplicate = trimmed !== '' && roots.some((r) => normalize(r.path) === normalize(trimmed));
  const relative = trimmed !== '' && !ABSOLUTE.test(trimmed);
  const problem = duplicate ? '这个文件夹已经在图库里了' : relative ? '需要完整路径，例如 D:\\Pictures\\插画' : serverError;

  const send = (p: string, merge?: boolean, how = { mode, comicRating }) => {
    lastSend.current = { path: p, ...how };
    setServerError(null);
    setConfirm(null);
    add.mutate({ p, merge, ...how });
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!trimmed || duplicate || relative) return;
    send(trimmed);
  };

  const browse = async () => {
    setPicking(true);
    setServerError(null);
    try {
      const { path: picked } = await api.pickFolder();
      if (!picked) return;
      setPath(picked);
      // 已经添加过：留在输入框里，由下方提示说明
      if (!roots.some((r) => normalize(r.path) === normalize(picked))) send(picked);
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setPicking(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented<LibraryRootMode>
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'auto', label: '插画 · 识别角色' },
            { value: 'comic', label: '漫画 · 跳过识别', icon: <BookOpen className="size-3.5" /> },
          ]}
        />
        {mode === 'comic' && (
          <div className="flex animate-fade-in items-center gap-2">
            <span className="text-xs text-fg-subtle">分级</span>
            <Segmented<Rating> size="sm" value={comicRating} onChange={setComicRating} options={RATINGS.map((r) => ({ value: r, label: RATING_LABEL[r] }))} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          autoFocus={autoFocus}
          size="lg"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setServerError(null);
            setConfirm(null);
          }}
          onClear={() => setPath('')}
          placeholder="D:\Pictures\插画"
          leading={<FolderOpen />}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!!problem}
          aria-describedby="add-folder-hint"
          className="min-w-0 flex-1 font-mono"
        />
        <Button type="button" variant="ghost" size="lg" icon={<FolderSearch />} loading={picking} onClick={browse}>
          浏览…
        </Button>
      </div>
      {confirm && (
        <div role="alertdialog" aria-label="合并文件夹" className="mt-3 animate-fade-in rounded-lg bg-sunken px-4 py-3">
          <p className="text-[13px] leading-relaxed">{confirm.question}</p>
          <div className="mt-2.5 flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              icon={<FolderInput />}
              loading={add.isPending}
              onClick={() => send(confirm.path, true, { mode: confirm.mode, comicRating: confirm.comicRating })}
            >
              合并成一个
            </Button>
          </div>
        </div>
      )}
      <p id="add-folder-hint" hidden={!!confirm} className={cn('mt-2 pl-4 text-xs', problem ? 'text-danger' : 'text-fg-subtle')}>
        {problem ??
          (mode === 'comic'
            ? '漫画：每个子文件夹算一本（按卷号排），页面直接归到别册 · 漫画，不跑识别、不找角色。没识别就不知道分级，先按上面选的显示。'
            : '支持本地磁盘和网络路径（\\\\NAS\\共享文件夹）。可以从资源管理器地址栏复制，或点「浏览…」选择。')}
      </p>
      {actions({ disabled: !trimmed || !!problem || !!confirm, loading: add.isPending })}
    </form>
  );
}

/** 已添加的文件夹：路径、张数、上次扫描、启用开关、移除（toast 可撤销） */
export function RootList({ roots, className }: { roots: LibraryRoot[]; className?: string }) {
  const update = useUpdateRoot();
  const remove = useRemoveRoot();
  const total = roots.reduce((sum, r) => sum + (r.enabled ? r.imageCount : 0), 0);
  return (
    <ul className={cn('relative divide-y divide-line', className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        {roots.map((root) => (
          <RootRow
            key={root.id}
            root={root}
            share={roots.length > 1 && total > 0 && root.enabled ? root.imageCount / total : null}
            onUpdate={(body) => update(root.id, body)}
            onRemove={() => remove(root.id)}
          />
        ))}
      </AnimatePresence>
    </ul>
  );
}

const RATINGS = Object.keys(RATING_LABEL) as Rating[];

/** 引导页用：上面一行添加表单，下面列表 */
export function LibraryRootsEditor({ roots }: { roots: LibraryRoot[] }) {
  return (
    <div>
      <AddFolderForm
        roots={roots}
        autoFocus
        actions={({ disabled, loading }) => (
          <div className="mt-3 flex justify-end">
            <Button type="submit" variant="primary" loading={loading} disabled={disabled}>
              添加
            </Button>
          </div>
        )}
      />
      {roots.length > 0 && (
        <div className="mt-5 rounded-xl bg-raised px-4 ring-1 ring-line">
          <RootList roots={roots} />
        </div>
      )}
    </div>
  );
}

/** D:/Pictures/插画 → 「D:/Pictures/」淡色 +「插画」正文色：一眼看到是哪个文件夹 */
function splitPath(path: string): { parent: string; leaf: string } {
  const p = path.replace(/[\\/]+$/, '');
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? { parent: '', leaf: p } : { parent: p.slice(0, i + 1), leaf: p.slice(i + 1) };
}

function RootRow({
  root,
  share,
  onUpdate,
  onRemove,
}: {
  root: LibraryRoot;
  /** 占全部已启用张数的比例；只有一个文件夹时不显示 */
  share: number | null;
  onUpdate: (body: UpdateLibraryRootBody) => void;
  onRemove: () => void;
}) {
  const comic = root.mode === 'comic';
  const { parent, leaf } = splitPath(root.path);
  const off = !root.enabled;
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12, transition: { duration: 0.2 } }}
      transition={{ duration: 0.35, ease: EASE_OUT }}
      className="group flex items-center gap-4 bg-raised py-4"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors duration-300 [&_svg]:size-[18px]',
          off ? 'text-fg-subtle ring-1 ring-line-strong ring-inset' : 'bg-sunken text-fg-muted',
        )}
      >
        {off ? <FolderX /> : <FolderOpen />}
      </span>

      <div className={cn('min-w-0 flex-1 transition-opacity duration-300', off && 'opacity-55')}>
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium" title={root.path}>
            <span className="text-fg-subtle">{parent}</span>
            {leaf}
          </div>
          {comic && (
            <Badge tone="ink" className="shrink-0">
              漫画 · {RATING_LABEL[root.comicRating]}
            </Badge>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-fg-muted">
          {off ? (
            '已停用：不参与浏览、统计和扫描'
          ) : root.lastScanAt ? (
            <span title={formatDateTime(root.lastScanAt)}>上次扫描 {formatRelative(root.lastScanAt)}</span>
          ) : (
            <span className="text-warn">还没有扫描过</span>
          )}
        </div>
      </div>

      <div className={cn('w-24 text-right transition-opacity duration-300', off && 'opacity-40')}>
        <div className="numeral text-[26px] tabular">{formatCount(root.imageCount)}</div>
        <div className="mt-1 text-[11px] text-fg-subtle tabular">
          {share !== null ? `张 · 占 ${formatPercent(share)}` : '张'}
        </div>
      </div>

      <div className="flex items-center gap-1 pl-2">
        <ModeMenu root={root} onUpdate={onUpdate} />
        <Switch checked={root.enabled} onCheckedChange={(enabled) => onUpdate({ enabled })} label={`启用 ${root.path}`} />
        <IconButton
          label="移除（不会删除磁盘上的文件）"
          onClick={onRemove}
          className="ml-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash />
        </IconButton>
      </div>
    </motion.li>
  );
}

/** 导入方式：插画（识别角色）/ 漫画（跳过识别，每个子文件夹一本）；漫画再选分级。改了可以撤销 */
function ModeMenu({ root, onUpdate }: { root: LibraryRoot; onUpdate: (body: UpdateLibraryRootBody) => void }) {
  const comic = root.mode === 'comic';
  return (
    <Menu
      align="end"
      width={248}
      trigger={
        <button
          type="button"
          aria-label={`导入方式：${comic ? '漫画' : '插画'}`}
          className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
        >
          {comic ? '漫画' : '插画'}
          <ChevronDown className="size-3.5 opacity-60" />
        </button>
      }
    >
      <MenuLabel>导入方式</MenuLabel>
      <MenuRadioGroup value={root.mode} onValueChange={(v) => onUpdate({ mode: v as LibraryRootMode })}>
        <MenuRadioItem value="auto">插画 · 识别角色</MenuRadioItem>
        <MenuRadioItem value="comic">漫画 · 跳过识别，每个子文件夹一本</MenuRadioItem>
      </MenuRadioGroup>
      {comic && (
        <>
          <MenuSeparator />
          <MenuLabel>没识别过的页按这个分级</MenuLabel>
          <MenuRadioGroup value={root.comicRating} onValueChange={(v) => onUpdate({ comicRating: v as Rating })}>
            {RATINGS.map((r) => (
              <MenuRadioItem key={r} value={r}>
                {RATING_LABEL[r]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </>
      )}
    </Menu>
  );
}
