import type { Rating } from '@emaki/shared';
import { Archive, Ban, Shapes, ShieldHalf } from 'lucide-react';
import type { RefObject } from 'react';
import { KindMenu } from '@/components/media/KindMenu';
import { Thumb } from '@/components/media/Thumb';
import { Kbd, Menu, MenuLabel, MenuRadioGroup, MenuRadioItem } from '@/components/ui';
import { formatCount, RATING_LABEL } from '@/lib/format';
import type { Sheet } from '../useSheet';
import { CharacterSearch } from './CharacterSearch';
import { PanelShell, SessionNote } from './DecisionPanel';
import { ActionKey, PanelSection } from './PanelParts';

const RATINGS: Rating[] = ['general', 'sensitive', 'questionable', 'explicit'];

/** 印样里选中图之后的右栏（T34c）：归到角色 / 放下 / 改类型 / 设分级 / 排除 */
export function SheetBatchPanel({
  sheet,
  label,
  mode,
  searchRef,
  onCreate,
  kindOpen,
  onKindOpen,
  ratingOpen,
  onRatingOpen,
}: {
  sheet: Sheet;
  label: string;
  mode: 'unsure' | 'shelved' | 'annex';
  searchRef: RefObject<HTMLInputElement | null>;
  onCreate: (name: string) => void;
  kindOpen: boolean;
  onKindOpen: (v: boolean) => void;
  ratingOpen: boolean;
  onRatingOpen: (v: boolean) => void;
}) {
  const n = sheet.selectedItems.length;
  const stack = sheet.selectedItems.slice(0, 3);
  return (
    <PanelShell
      footer={
        <>
          <div className="grid grid-cols-2 gap-2">
            {mode !== 'annex' && (
              <ActionKey
                icon={<Archive />}
                label={mode === 'shelved' ? '放回未识别' : '放下'}
                keys={['H']}
                onClick={() => sheet.shelve(mode !== 'shelved')}
              />
            )}
            <KindMenu
              align="start"
              label={`把 ${formatCount(n)} 张改成`}
              open={kindOpen}
              onOpenChange={onKindOpen}
              onSelect={sheet.setKind}
              trigger={
                <div className="grid">
                  <ActionKey icon={<Shapes />} label="改类型…" keys={['C']} onClick={() => onKindOpen(true)} />
                </div>
              }
            />
            <Menu
              width={180}
              align="start"
              open={ratingOpen}
              onOpenChange={onRatingOpen}
              onKeyDown={(e) => {
                const i = Number(e.key) - 1;
                if (RATINGS[i]) {
                  e.preventDefault();
                  onRatingOpen(false);
                  sheet.setRating(RATINGS[i]!);
                }
              }}
              trigger={
                <div className="grid">
                  <ActionKey icon={<ShieldHalf />} label="设分级…" keys={['R']} onClick={() => onRatingOpen(true)} />
                </div>
              }
            >
              <MenuLabel>把 {formatCount(n)} 张设为</MenuLabel>
              <MenuRadioGroup value="" onValueChange={(v) => sheet.setRating(v as Rating)}>
                {RATINGS.map((r, i) => (
                  <MenuRadioItem key={r} value={r}>
                    <span className="flex w-full items-center justify-between">
                      {RATING_LABEL[r]}
                      <Kbd>{i + 1}</Kbd>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </Menu>
            <ActionKey icon={<Ban />} label={`排除这 ${formatCount(n)} 张`} keys={['E']} tone="danger" onClick={sheet.exclude} />
          </div>
          <button type="button" onClick={sheet.clear} className="mt-2 w-full text-center text-[12px] text-fg-subtle transition-colors hover:text-fg">
            取消选择 <Kbd>Esc</Kbd>
          </button>
          {mode !== 'annex' && (
            <p className="mt-3 text-[11.5px] leading-relaxed text-fg-subtle">放下 = 不找角色了：图还在图库里，只是不再出现在未识别；「放下的」里可以放回来。</p>
          )}
          <SessionNote count={sheet.doneCount} idle="悬停勾选 · Ctrl+A 全选已加载 · [ ] 换组" />
        </>
      }
    >
      <div className="flex items-center gap-4">
        <div className="relative h-[76px] w-[60px] shrink-0">
          {stack.map((img, i) => (
            <div
              key={img.id}
              className="absolute inset-0 transition-transform duration-500 ease-[var(--ease-out-soft)]"
              style={{ transform: `rotate(${i === 0 ? 0 : i % 2 ? -8 : 7}deg) translateX(${i * 3}px)`, zIndex: stack.length - i }}
            >
              <Thumb image={img} width={240} className="size-full rounded-[10px] shadow-card ring-2 ring-sheet" />
            </div>
          ))}
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="numeral text-[44px] text-fg">{formatCount(n)}</span>
            <span className="text-[13px] text-fg-muted">张已选中</span>
          </div>
          <div className="mt-1 text-[12px] text-fg-subtle">来自「{label}」</div>
        </div>
      </div>

      <PanelSection title="归到角色" hint="/ 搜索 · ↵ 归入">
        <CharacterSearch inputRef={searchRef} recent={sheet.recent} onPick={sheet.assign} onCreate={onCreate} placeholder="搜索角色，或新建自建角色…" />
      </PanelSection>
    </PanelShell>
  );
}
