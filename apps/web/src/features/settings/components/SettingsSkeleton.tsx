import { Skeleton } from '@/components/ui';
import { SECTIONS } from '../sections';

/** 骨架和最终布局同形：左目录 + 右侧几张「编号标题 + 行卡片」 */
export function SettingsSkeleton() {
  return (
    <div className="flex gap-14" aria-busy aria-label="正在加载设置">
      <div className="hidden w-44 shrink-0 border-l border-line lg:block">
        {SECTIONS.map((s, i) => (
          <div key={s.id} className="flex items-center gap-3 py-[9px] pl-4">
            <Skeleton className="h-3.5 w-4" />
            <Skeleton className="h-3.5" style={{ width: `${48 + ((i * 23) % 40)}%` }} />
          </div>
        ))}
      </div>
      <div className="max-w-[760px] min-w-0 flex-1 space-y-10">
        {[3, 5, 2].map((rows, i) => (
          <div key={i}>
            <div className="mb-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-6 w-8" />
                <Skeleton className="h-5 w-28" />
              </div>
              <Skeleton className="mt-2.5 ml-11 h-3.5 w-80" />
            </div>
            <div className="divide-y divide-line rounded-xl bg-raised px-5 ring-1 ring-line">
              {Array.from({ length: rows }, (_, j) => (
                <div key={j} className="flex items-center justify-between gap-6 py-4">
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-64" />
                  </div>
                  <Skeleton className="h-7 w-40 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
