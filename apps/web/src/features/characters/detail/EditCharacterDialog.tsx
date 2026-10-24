import type { Character, UpdateCharacterBody } from '@emaki/shared';
import { TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Dialog, DialogFooter, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutate } from '@/lib/queries';
import { useRecentCharacters } from '@/features/gallery/recentCharacters';
import { useDuplicateHint } from '../overview/NewCharacterDialog';
import { AliasInput } from './AliasInput';
import { WorkPicker } from './WorkPicker';

/** 编辑角色：名字、别名、Danbooru 标签、所属作品。只提交改动过的字段。 */
export function EditCharacterDialog({
  open,
  onOpenChange,
  character,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  character: Character;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="编辑角色"
      description="别名用于搜索；填上 Danbooru 标签后，识别结果会自动归到这个角色。"
      width={540}
    >
      {/* 表单放在 Dialog 内容里：每次打开都从最新数据重新初始化 */}
      <EditForm character={character} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

function EditForm({ character, onDone }: { character: Character; onDone: () => void }) {
  const uid = useId();
  const [name, setName] = useState(character.name);
  const [aliases, setAliases] = useState(character.aliases);
  const [tag, setTag] = useState(character.danbooruTag ?? '');
  const [workIds, setWorkIds] = useState(character.workIds);

  const save = useMutate((body: UpdateCharacterBody) => api.updateCharacter(character.id, body), {
    onSuccess: (_, b) => {
      // 选择器「最近使用」里的快照跟着改名
      useRecentCharacters.getState().patch({
        id: character.id,
        name: b.name ?? character.name,
        aliases: b.aliases ?? character.aliases,
        workIds: b.workIds ?? character.workIds,
        danbooruTag: b.danbooruTag === undefined ? character.danbooruTag : b.danbooruTag,
      });
      onDone();
    },
  });

  const body: UpdateCharacterBody = {};
  if (name.trim() !== character.name) body.name = name.trim();
  if (aliases.join('\u0000') !== character.aliases.join('\u0000')) body.aliases = aliases;
  const nextTag = tag.trim() || null;
  if (nextTag !== character.danbooruTag) body.danbooruTag = nextTag;
  if (workIds.join(',') !== character.workIds.join(',')) body.workIds = workIds;
  const dirty = Object.keys(body).length > 0;
  const valid = name.trim().length > 0;
  // 改成了已有角色的名字：只提醒，不拦（不同作品同名是正常的）
  const duplicate = useDuplicateHint(body.name ?? '', { except: character.id, sameWork: workIds });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && valid) save.mutate(body);
      }}
      className="flex flex-col gap-5"
    >
      <FormField label="名字" htmlFor={`${uid}-name`}>
        <Input
          id={`${uid}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如 圣园未花"
          autoFocus
          maxLength={100}
        />
        {duplicate && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-warn animate-fade-in">
            <TriangleAlert className="size-3.5 shrink-0" />
            <span>
              已经有一个「{duplicate.name}」{duplicate.workName ? `（${duplicate.workName}）` : ''}，
              <Link to={`/characters/${duplicate.id}`} onClick={onDone} className="font-medium underline-offset-4 hover:underline">
                去看看
              </Link>
              ；是同一个人的话，用「更多 → 合并到其他角色」
            </span>
          </p>
        )}
      </FormField>

      <FormField label="别名" htmlFor={`${uid}-aliases`} hint="日文名、英文名、昵称都可以，搜索时会一起匹配">
        <AliasInput id={`${uid}-aliases`} value={aliases} onChange={setAliases} />
      </FormField>

      <FormField
        label="Danbooru 标签"
        htmlFor={`${uid}-tag`}
        hint={character.danbooruTag ? undefined : '留空表示自建角色'}
      >
        <Input
          id={`${uid}-tag`}
          value={tag}
          onChange={(e) => setTag(e.target.value.replace(/\s+/g, '_'))}
          placeholder="例如 mika_(blue_archive)"
          spellCheck={false}
          className="font-mono [&_input]:text-[13px]"
          onClear={() => setTag('')}
        />
      </FormField>

      <FormField label="所属作品" hint="第一个是主作品；点已选的作品可以移除">
        <WorkPicker value={workIds} onChange={setWorkIds} />
      </FormField>

      <DialogFooter className="mt-1">
        <Button type="button" variant="ghost" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || !valid} loading={save.isPending}>
          保存
        </Button>
      </DialogFooter>
    </form>
  );
}

function FormField({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-fg">
          {label}
        </label>
        {hint && <span className="truncate text-[11.5px] text-fg-subtle">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
