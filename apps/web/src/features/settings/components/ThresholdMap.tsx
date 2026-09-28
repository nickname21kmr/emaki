import { cn } from '@/lib/cn';

const f2 = (v: number) => v.toFixed(2);

/**
 * 「一张图会被怎么处理」：把角色阈值和自动采纳阈值画成一条 0~1 的分段条。
 * 两个滑块单看很抽象，放在一起才看得出中间那段就是「未识别」要人工确认的量。
 */
export function ThresholdMap({ character, auto }: { character: number; auto: number }) {
  const upper = Math.max(character, auto);
  const segments = [
    { key: 'drop', grow: character, bar: 'bg-line-strong', label: '不算识别', range: `< ${f2(character)}` },
    {
      key: 'review',
      grow: upper - character,
      bar: 'bg-shu',
      label: '进入「未识别」等你确认',
      range: upper > character ? `${f2(character)} – ${f2(upper)}` : '无',
    },
    { key: 'auto', grow: 1 - upper, bar: 'bg-ink', label: '直接归到角色', range: `≥ ${f2(upper)}` },
  ];

  return (
    <div>
      <div className="flex h-2 gap-[3px]" aria-hidden>
        {/* 宽度为 0 的段不渲染，否则会多出一道空隙 */}
        {segments
          .filter((s) => s.grow > 0)
          .map((s) => (
            <div
              key={s.key}
              className={cn('h-full min-w-0 basis-0 rounded-full transition-[flex-grow] duration-300 ease-out', s.bar)}
              style={{ flexGrow: s.grow }}
            />
          ))}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-4 text-xs">
        {segments.map((s) => (
          <div key={s.key} className="flex min-w-0 items-start gap-2">
            <span className={cn('mt-[3px] size-2 shrink-0 rounded-full', s.bar)} />
            <div className="min-w-0">
              <dt className="text-fg">{s.label}</dt>
              <dd className="mt-0.5 text-fg-subtle tabular">{s.range}</dd>
            </div>
          </div>
        ))}
      </dl>
      {auto <= character && (
        <p className="mt-3 text-xs text-warn">
          自动采纳阈值不高于角色阈值：识别出的角色会全部直接采纳，不再进入「未识别」。
        </p>
      )}
    </div>
  );
}
