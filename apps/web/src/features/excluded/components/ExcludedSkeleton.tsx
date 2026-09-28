/** 已排除页的骨架：规则行 + 单张小网格，和真实布局同尺寸 */
export function ExcludedSkeleton() {
  return (
    <div className="space-y-10" aria-busy="true" aria-label="正在加载排除规则">
      <section>
        <div className="mb-3 flex items-baseline gap-2.5">
          <div className="skeleton h-4 w-10 rounded-sm" />
          <div className="skeleton h-3 w-40 rounded-sm" />
        </div>
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex h-[78px] items-center gap-5 rounded-[16px] bg-raised px-4 ring-1 ring-line">
              <div className="skeleton size-11 shrink-0 rounded-[12px]" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="skeleton h-4 w-48 max-w-full rounded-sm" />
                <div className="skeleton h-3 w-64 max-w-full rounded-sm" />
              </div>
              <div className="relative hidden h-[76px] w-[132px] shrink-0 md:block">
                {[0, 1, 2, 3].map((k) => (
                  <div
                    key={k}
                    className="skeleton absolute top-2 h-[60px] w-[46px] rounded-[6px] ring-2 ring-raised"
                    style={{ left: k * 14, transform: `rotate(${(k - 1.5) * 5}deg)` }}
                  />
                ))}
              </div>
              <div className="skeleton h-7 w-14 rounded-sm" />
              <div className="skeleton h-7 w-16 rounded-sm" />
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="mb-3 flex items-baseline gap-2.5">
          <div className="skeleton h-4 w-16 rounded-sm" />
          <div className="skeleton h-3 w-44 rounded-sm" />
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2.5">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton aspect-[3/4] rounded-[10px]" />
          ))}
        </div>
      </section>
    </div>
  );
}
