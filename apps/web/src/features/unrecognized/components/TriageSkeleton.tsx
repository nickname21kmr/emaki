import { Skeleton } from '@/components/ui';

/** 加载骨架：和最终的三栏布局一一对应，加载完不会跳 */
export function TriageSkeleton() {
  return (
    <>
      <aside className="flex min-h-0 w-[232px] shrink-0 flex-col xl:w-[264px]" aria-hidden>
        <div className="flex h-8 items-center justify-between px-2">
          <Skeleton className="h-3.5 w-9" />
          <Skeleton className="h-3 w-12" />
        </div>
        <div className="mt-2 min-h-0 flex-1 overflow-hidden">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="py-[3px] pr-1 pl-2">
              <div className="flex w-full items-center gap-3 p-1.5 pr-3" style={{ opacity: 1 - i * 0.07 }}>
                <Skeleton className="size-12 shrink-0 rounded-[10px]" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2 w-1/2" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-hidden>
        <Skeleton className="min-h-0 flex-1 rounded-[20px]" />
      </div>

      <section className="flex min-h-0 w-[300px] shrink-0 flex-col xl:w-[340px] 2xl:w-[380px]" aria-hidden>
        <div className="min-h-0 flex-1">
          <Skeleton className="h-11 w-24" />
          <Skeleton className="mt-5 h-4 w-44" />
          <Skeleton className="mt-2 h-3 w-36" />
          <Skeleton className="mt-8 h-3 w-20" />
          <Skeleton className="mt-3 h-[66px] w-full rounded-[14px]" />
          <Skeleton className="mt-2 h-[66px] w-full rounded-[14px]" />
          <Skeleton className="mt-8 h-3 w-24" />
          <Skeleton className="mt-3 h-11 w-full rounded-full" />
        </div>
        <div className="shrink-0 border-t border-line pt-4">
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-[62px] rounded-[12px]" />
            <Skeleton className="h-[62px] rounded-[12px]" />
            <Skeleton className="h-[62px] rounded-[12px]" />
          </div>
          <div className="mt-3 h-4" />
        </div>
      </section>
    </>
  );
}
