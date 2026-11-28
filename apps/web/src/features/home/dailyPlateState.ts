import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface DailyPlateState {
  day: string;
  shuffle: number;
  next: (day: string) => void;
}

/** Keep today's chosen seed across navigation and reloads in this browser tab. */
export const useDailyPlateState = create<DailyPlateState>()(
  persist(
    (set) => ({
      day: '',
      shuffle: 0,
      next: (day) => set((s) => ({day, shuffle: s.day === day ? s.shuffle + 1 : 1})),
    }),
    {
      name: 'emaki.daily-plate',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({day: s.day, shuffle: s.shuffle}),
    },
  ),
);

/** 存的是 '1' / '0'；没记过（第一次打开）、读到别的东西都按有算 */
export const expectsPlate = (raw: string | null): boolean => raw !== '0';

const LAST_KEY = 'emaki.daily-plate.last';

/**
 * 上次打开首页时有没有图版（放 localStorage，关掉窗口还在；只记有没有，不存图）。
 * 抽到之前占不占位置、要不要提前去抽都看它：上次有就先占着，下面几块不会被顶下去；
 * 上次没有（空库、没有插画、模糊开着又没分级过）就不占，免得占位出现又收掉。
 * 读写都包着 try / catch：隐私模式、存储被禁用时按第一次算
 */
export const lastPlate = {
  get(): boolean {
    try {
      return expectsPlate(localStorage.getItem(LAST_KEY));
    } catch {
      return expectsPlate(null);
    }
  },
  set(has: boolean): void {
    try {
      localStorage.setItem(LAST_KEY, has ? '1' : '0');
    } catch {
      /* 存不了就算了：下次照第一次的规矩占位 */
    }
  },
};

/** 图版的形状：宽高比夹在 0.66–2.4 之间；比 1.2 窄的算竖图（图框固定高 440，文字在右边） */
export function plateShape(width: number, height: number): { ar: number; tall: boolean } {
  const ar = Math.min(Math.max(width / Math.max(height, 1), 0.66), 2.4);
  return { ar, tall: ar < 1.2 };
}
