import type { CreateCharacterBody, ID, Character } from '@emaki/shared';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Dialog, DialogFooter, Input, Kbd } from '@/components/ui';
import { api } from '@/lib/api';
import { modKeyLabel } from '@/lib/hotkeys';
import { useMutate, useSearch } from '@/lib/queries';
import { AliasInput } from './AliasInput';
import { WorkPicker } from './WorkPicker';

/**
 * 新建自建角色：名字、所属作品、别名、Danbooru 标签（可选）。
 * 表单放在子组件里——Dialog 关闭时内容会卸载，下次打开 useState 自然回到初始值，不用手动重置。
 */
export function NewCharacterDialog({
  open,
  onOpenChange,
  initialName,
  initialWorkId,
  onCreated,
}: {
  /** 传了就不跳转到新角色页，交给调用方（未识别里「新建并归入」） */
  onCreated?: (c: Character) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 从「没有找到『xxx』」进来时预填搜索词 */
  initialName?: string;
  /** 当前正在看某部作品时，默认归到这部作品 */
  initialWorkId?: ID;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={520}
      title="新建自建角色"
      description="Danbooru 上没有的角色（原创、冷门、画师 OC）可以在这里手动建，之后把图归过去。"
    >
      <NewCharacterForm
        initialName={initialName}
        initialWorkId={initialWorkId}
        onCreated={onCreated}
        onDone={() => onOpenChange(false)}
      />
    </Dialog>
  );
}

function NewCharacterForm({
  initialName,
  initialWorkId,
  onCreated,
  onDone,
}: {
  initialName?: string;
  initialWorkId?: ID;
  onCreated?: (c: Character) => void;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const ids = useId();
  const [name, setName] = useState(initialName ?? '');
  const [workIds, setWorkIds] = useState<ID[]>(initialWorkId ? [initialWorkId] : []);
  const [aliases, setAliases] = useState<string[]>([]);
  const [tag, setTag] = useState('');

  const create = useMutate((body: CreateCharacterBody) => api.createCharacter(body), {
    onSuccess: (res) => {
      if (onCreated) {
        onCreated(res.character);
        onDone();
        return;
      }
      onDone();
      navigate(`/characters/${res.character.id}`);
    },
  });

  const trimmed = name.trim();
  const duplicate = useDuplicateHint(trimmed);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!trimmed || create.isPending) return;
    // Danbooru 标签约定：小写、空格写成下划线
    const danbooruTag = tag.trim().toLowerCase().replace(/\s+/g, '_') || null;
    create.mutate({ name: trimmed, workIds, aliases, danbooruTag });
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        // Ctrl / ⌘ + 回车：在任何输入框里都能直接提交
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      }}
      className="space-y-5"
    >
      <FormRow label="名字" htmlFor={`${ids}-name`} required>
        <Input
          id={`${ids}-name`}
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：雪见"
          autoComplete="off"
        />
        {duplicate && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-warn animate-fade-in">
            <TriangleAlert className="size-3.5 shrink-0" />
            <span>
              库里已经有「{duplicate.name}」{duplicate.workName ? `（${duplicate.workName}）` : ''}，
              <Link
                to={`/characters/${duplicate.id}`}
                onClick={onDone}
                className="font-medium underline-offset-4 hover:underline"
              >
                去看看
              </Link>
              ，还是要再建一个？
            </span>
          </p>
        )}
      </FormRow>

      <FormRow label="所属作品" hint="不属于任何作品（比如画师 OC）可以不选。">
        <WorkPicker value={workIds} onChange={setWorkIds} />
      </FormRow>

      <FormRow label="别名" htmlFor={`${ids}-alias`} hint="日文名、罗马音、简称都行，回车或逗号分隔；搜索时会用到。">
        <AliasInput id={`${ids}-alias`} value={aliases} onChange={setAliases} />
      </FormRow>

      <FormRow
        label="Danbooru 标签"
        htmlFor={`${ids}-tag`}
        optional
        hint="填了之后按 Danbooru 角色对待：tagger 识别到这个标签时会自动归到这里。"
      >
        <Input
          id={`${ids}-tag`}
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="mika_(blue_archive)"
          autoComplete="off"
          spellCheck={false}
          className="font-mono [&_input]:text-[13px]"
        />
      </FormRow>

      <DialogFooter className="mt-7">
        <span className="mr-auto hidden items-center gap-1 text-[11px] text-fg-subtle sm:inline-flex">
          <Kbd>{modKeyLabel}</Kbd>
          <Kbd>↵</Kbd>
          创建
        </span>
        <Button type="button" variant="ghost" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!trimmed}>
          创建角色
        </Button>
      </DialogFooter>
    </form>
  );
}

function FormRow({
  label,
  htmlFor,
  hint,
  required,
  optional,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  required?: boolean;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-fg-muted">
        {label}
        {required && <span className="size-1 rounded-full bg-shu" aria-label="必填" />}
        {optional && <span className="font-normal text-fg-subtle">可选</span>}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-subtle">{hint}</p>}
    </div>
  );
}

/** 名字停下来 300ms 后查一下有没有同名 / 同别名的角色，避免重复建 */
function useDuplicateHint(name: string) {
  const [debounced, setDebounced] = useState(name);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(name), 300);
    return () => window.clearTimeout(t);
  }, [name]);

  const { data } = useSearch(debounced);
  if (!debounced || debounced !== name || !data) return null;
  const key = debounced.toLowerCase();
  for (const hit of data) {
    if (hit.type !== 'character') continue;
    const c = hit.character;
    if (c.name.toLowerCase() === key || c.aliases.some((a) => a.toLowerCase() === key)) {
      return { id: c.id, name: c.name, workName: hit.workName };
    }
  }
  return null;
}
