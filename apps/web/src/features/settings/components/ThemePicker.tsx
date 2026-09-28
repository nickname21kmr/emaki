import type { ID, ThemePreference } from '@emaki/shared';
import { Check, Moon, Sun, SunMoon, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useSyncExternalStore } from 'react';
import { Thumb } from '@/components/media/Thumb';
import { cn } from '@/lib/cn';
import { useTopCharacters } from '@/lib/queries';
import { usePrefs, type Palette } from '@/lib/stores';
import { EASE_OUT } from '@/lib/motion';

const OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: '跟随系统', icon: SunMoon },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
];

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeSystem(cb: () => void) {
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

const useSystemDark = () => useSyncExternalStore(subscribeSystem, () => window.matchMedia(DARK_QUERY).matches);

/**
 * 主题选择：三张小预览卡，画的是 Emaki 自己的缩略版（侧栏、纸、几张你收藏的角色封面），
 * 每张用对应主题的 token 渲染，所以看到的就是切过去之后的样子。
 */
export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (v: ThemePreference) => void;
}) {
  const systemDark = useSystemDark();

  const { data: top } = useTopCharacters({ limit: 3 });
  const covers = (top ?? []).flatMap((c) => (c.coverImageId ? [c.coverImageId] : []));

  return (
    <div role="radiogroup" aria-label="主题" className="grid grid-cols-3 gap-4">
      {OPTIONS.map((opt) => {
        const selected = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className="group rounded-[14px] text-left"
          >
            <div
              className={cn(
                'relative aspect-[16/10] overflow-hidden rounded-[12px]',
                'transition-[box-shadow,transform] duration-300 ease-[var(--ease-out-soft)]',
                selected
                  ? 'shadow-[0_0_0_2px_var(--c-raised),0_0_0_4px_var(--c-shu)]'
                  : 'shadow-[0_0_0_1px_var(--c-line-strong)] group-hover:-translate-y-0.5 group-hover:shadow-[0_0_0_1px_var(--c-line-strong),var(--shadow-lift)]',
              )}
            >
              {opt.value === 'system' ? (
                <>
                  <MiniApp mode="light" covers={covers} />
                  {/* 斜切一刀，右半边是深色 */}
                  <div className="absolute inset-0 [clip-path:polygon(60%_0,100%_0,100%_100%,40%_100%)]">
                    <MiniApp mode="dark" covers={covers} />
                  </div>
                </>
              ) : (
                <MiniApp mode={opt.value} covers={covers} />
              )}
              <AnimatePresence>
                {selected && (
                  <motion.span
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.5, opacity: 0 }}
                    transition={{ duration: 0.2, ease: EASE_OUT }}
                    className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-shu text-white shadow-lift"
                  >
                    <Check className="size-3" strokeWidth={3} />
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <div className="mt-2.5 flex items-center gap-1.5 text-[13px]">
              <Icon className={cn('size-3.5', selected ? 'text-fg' : 'text-fg-subtle')} />
              <span className={selected ? 'font-medium text-fg' : 'text-fg-muted group-hover:text-fg'}>{opt.label}</span>
              {opt.value === 'system' && (
                <span className="text-xs text-fg-subtle">· 现在是{systemDark ? '深色' : '浅色'}</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** 缩略版的应用界面，只用语义 token；靠 data-theme 局部换肤（颜色 token 是 @theme inline，见 styles/index.css） */
export function MiniApp({ mode, covers, palette }: { mode: 'light' | 'dark'; covers: ID[]; palette?: Palette }) {
  const current = usePrefs((s) => s.palette);
  return (
    <div
      data-theme={mode}
      data-palette={palette ?? current}
      style={{ colorScheme: mode }}
      className="absolute inset-0 flex gap-[5px] bg-canvas p-[5px]"
    >
      <div className="flex w-[14px] shrink-0 flex-col items-center gap-[5px] pt-[3px]">
        <span className="size-[9px] -rotate-[8deg] rounded-[2.5px] bg-shu" />
        <span className="mt-[3px] size-[6px] rounded-[2px] bg-fg-subtle/60" />
        <span className="size-[6px] rounded-[2px] bg-fg-subtle/40" />
        <span className="size-[6px] rounded-[2px] bg-fg-subtle/40" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] bg-sheet p-[8px] shadow-[0_0_0_1px_var(--c-line)]">
        <span className="h-[5px] w-[34%] shrink-0 rounded-full bg-fg/80" />
        <span className="mt-[4px] h-[3px] w-[52%] shrink-0 rounded-full bg-fg-subtle/50" />
        <div className="mt-auto grid grid-cols-3 gap-[4px]">
          {[0, 1, 2].map((i) => {
            const id = covers[i];
            return (
              <div key={i} className="aspect-[4/5] overflow-hidden rounded-[4px] bg-sunken">
                {id && (
                  <Thumb
                    image={{ id, dominantColor: 'var(--c-sunken)', rating: 'general' }}
                    width={240}
                    className="size-full"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
