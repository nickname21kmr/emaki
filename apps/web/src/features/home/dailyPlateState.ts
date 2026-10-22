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
