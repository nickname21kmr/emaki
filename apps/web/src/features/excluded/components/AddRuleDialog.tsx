import type { CreateExclusionBody, Exclusion, ExclusionKind } from '@emaki/shared';
import { Folder, Hash, UserRound } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, DialogFooter, Segmented } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutate } from '@/lib/queries';
import { normalizeTarget } from '../utils';
import { CharacterPicker, type PickedCharacter } from './CharacterPicker';
import { FolderField, TagField } from './RuleFields';
import { EASE_OUT } from '@/lib/motion';

type RuleKind = Exclude<ExclusionKind, 'image'>;

/**
 * 「添加规则」：类型（标签 / 文件夹 / 角色）+ 目标。
 * Dialog 关闭时内容会卸载，所以每次打开都是干净的表单。
 */
export function AddRuleDialog({
  open,
  onOpenChange,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: Exclusion[];
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加排除规则"
      description="符合规则的图片会从图库和统计里隐藏，文件本身不会被删除，随时可以恢复。"
      width={520}
    >
      <AddRuleForm existing={existing} onClose={() => onOpenChange(false)} />
    </Dialog>
  );
}

function AddRuleForm({ existing, onClose }: { existing: Exclusion[]; onClose: () => void }) {
  const [kind, setKind] = useState<RuleKind>('tag');
  const [tag, setTag] = useState('');
  const [folder, setFolder] = useState('');
  const [character, setCharacter] = useState<PickedCharacter | null>(null);

  const target =
    kind === 'tag' ? normalizeTarget('tag', tag) : kind === 'folder' ? normalizeTarget('folder', folder) : (character?.id ?? '');
  const duplicate = !!target && existing.some((e) => e.kind === kind && e.target === target);

  const create = useMutate((body: CreateExclusionBody) => api.createExclusion(body), { onSuccess: onClose });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!target || duplicate || create.isPending) return;
    create.mutate({ kind, target });
  };

  // Segmented 的按钮没写 type，放在 form 里会被当成提交按钮，所以放在 form 外面
  return (
    <>
      <Segmented<RuleKind>
        value={kind}
        onChange={setKind}
        options={[
          { value: 'tag', label: '标签', icon: <Hash /> },
          { value: 'folder', label: '文件夹', icon: <Folder /> },
          { value: 'character', label: '角色', icon: <UserRound /> },
        ]}
      />

      <form onSubmit={submit}>
        {/* 固定最小高度，切换类型时弹窗不跳 */}
        <div className="mt-5 min-h-[212px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={kind}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: EASE_OUT }}
            >
              {kind === 'tag' && (
                <TagField value={tag} onChange={setTag} normalized={target} existing={existing} />
              )}
              {kind === 'folder' && <FolderField value={folder} onChange={setFolder} />}
              {kind === 'character' && <CharacterPicker value={character} onChange={setCharacter} />}
            </motion.div>
          </AnimatePresence>
        </div>

        <DialogFooter>
          <p className="mr-auto text-[12.5px] text-warn" aria-live="polite">
            {duplicate ? '已经有这条规则了' : ''}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={!target || duplicate} loading={create.isPending}>
              添加规则
            </Button>
          </div>
        </DialogFooter>
      </form>
    </>
  );
}
