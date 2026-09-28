import { TILE_GAP, TILE_HEIGHT } from '../utils';

/** 每组的图片比例：竖图对、横图对、三张竖图 —— 和真实数据的样子差不多 */
const SHAPES = [
  [0.72, 0.72],
  [1.78, 1.78],
  [0.66, 0.66, 0.66],
];

/** 待处理列表的骨架：和 DuplicateGroupCard 同样的结构与尺寸 */
export function DuplicatesSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="正在加载重复组">
      {SHAPES.map((ratios, i) => {
        const sum = ratios.reduce((a, b) => a + b, 0);
        return (
          <div key={i} className="rounded-[18px] bg-raised p-5 ring-1 ring-line">
            <div className="mb-4 flex items-center gap-3">
              <div className="skeleton h-6 w-8 rounded-sm" />
              <div className="skeleton h-5 w-16 rounded-full" />
              <div className="skeleton h-3.5 w-8 rounded-sm" />
              <div className="skeleton ml-auto h-3.5 w-24 rounded-sm" />
            </div>
            <div
              className="flex"
              style={{ gap: TILE_GAP, maxWidth: `calc(${sum} * ${TILE_HEIGHT}px + ${(ratios.length - 1) * TILE_GAP}px)` }}
            >
              {ratios.map((r, k) => (
                <div key={k} className="min-w-0" style={{ flex: `${r} 1 0%` }}>
                  <div className="skeleton rounded-[12px]" style={{ aspectRatio: r }} />
                  <div className="mt-3 space-y-1.5">
                    <div className="skeleton h-3 w-3/4 rounded-sm" />
                    <div className="skeleton h-3 w-1/2 rounded-sm" />
                    <div className="skeleton h-3 w-2/3 rounded-sm" />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-center gap-3 border-t border-line pt-4">
              <div className="skeleton h-3.5 w-40 rounded-sm" />
              <div className="skeleton ml-auto h-7 w-20 rounded-sm" />
              <div className="skeleton h-7 w-44 rounded-sm" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
