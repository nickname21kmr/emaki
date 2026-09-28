import { Ban, Shapes, X } from 'lucide-react';
import { KindMenu } from '@/components/media/KindMenu';
import type { RefObject } from 'react';
import { Thumb } from '@/components/media/Thumb';
import { formatCount } from '@/lib/format';
import type { Triage } from '../useTriage';
import { CharacterSearch } from './CharacterSearch';
import { PanelShell, SessionNote } from './DecisionPanel';
import { ActionKey, PanelSection, SuggestionRow } from './PanelParts';

/**
 * 多选时的决策面板：把选中的图一次归到同一个角色。
 * 「共同建议」= 选中的图里 tagger 建议过的角色，按命中张数排。
 */
export function BatchPanel({ triage, searchRef }: { triage: Triage; searchRef: RefObject<HTMLInputElement | null> }) {
  const { selectedItems, aggregated } = triage;
  const n = selectedItems.length;
  // 叠在一起的前三张，像一小叠照片
  const stack = selectedItems.slice(0, 3);

  return (
    <PanelShell
      footer={
        <>
          <div className="grid grid-cols-3 gap-2">
            <KindMenu
              align="start"
              label={`把 ${formatCount(n)} 张标为`}
              includeIllustration={false}
              open={triage.kindMenuOpen}
              onOpenChange={triage.setKindMenuOpen}
              onSelect={triage.markKind}
              trigger={
                <div className="grid">
                  <ActionKey icon={<Shapes />} label="标为…" keys={['N']} onClick={() => triage.setKindMenuOpen(true)} />
                </div>
              }
            />
            <ActionKey icon={<Ban />} label={`排除这 ${formatCount(n)} 张`} keys={['E']} onClick={triage.exclude} tone="danger" />
            <ActionKey icon={<X />} label="取消选择" keys={['Esc']} onClick={triage.clearSelection} />
          </div>
          <SessionNote count={triage.doneCount} />
        </>
      }
    >
      <div className="flex items-center gap-4">
        <div className="relative h-[76px] w-[60px] shrink-0">
          {stack.map((it, i) => (
            <div
              key={it.image.id}
              className="absolute inset-0 transition-transform duration-500 ease-[var(--ease-out-soft)]"
              // 第一张摆正在最上面，后面的左右交替错开一点角度
              style={{
                transform: `rotate(${i === 0 ? 0 : i % 2 ? -8 : 7}deg) translateX(${i * 3}px)`,
                zIndex: stack.length - i,
              }}
            >
              <Thumb image={it.image} width={240} className="size-full rounded-[10px] shadow-card ring-2 ring-sheet" />
            </div>
          ))}
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="numeral text-[44px] text-fg">{formatCount(n)}</span>
            <span className="text-[13px] text-fg-muted">张已选中</span>
          </div>
          <div className="mt-1 text-[12px] text-fg-subtle">归到同一个角色，或一起排除</div>
        </div>
      </div>

      <PanelSection title="共同建议" hint={aggregated.length ? '按数字键归入全部' : undefined}>
        {aggregated.length ? (
          <div className="space-y-2">
            {aggregated.map((s, i) => (
              <SuggestionRow
                key={s.danbooruTag}
                n={i + 1}
                name={s.name}
                workName={s.workName}
                value={s.hits / n}
                valueLabel={`${s.hits}/${n}`}
                valueUnit="张"
                title={`${s.danbooruTag} · ${s.hits} 张图给出了这条建议`}
                onPick={() => triage.acceptAggregated(s)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-[14px] border border-dashed border-line-strong px-4 py-4 text-[12.5px] leading-relaxed text-fg-muted">
            选中的图没有可以直接归入的共同建议，在下面搜索角色即可。
          </div>
        )}
      </PanelSection>

      <PanelSection title={`把 ${formatCount(n)} 张归到`} hint="↑↓ 选择 · ↵ 归入">
        <CharacterSearch inputRef={searchRef} recent={triage.recent} onPick={triage.assign} placeholder="搜索角色…" />
      </PanelSection>
    </PanelShell>
  );
}
