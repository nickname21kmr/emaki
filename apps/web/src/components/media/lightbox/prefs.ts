import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 看图器自己的偏好：信息面板开没开（按 I 切换），下次打开时保持 */
interface LightboxPrefs {
  panelOpen: boolean;
  togglePanel: () => void;
}

export const useLightboxPrefs = create<LightboxPrefs>()(
  persist(
    (set) => ({
      panelOpen: true,
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
    }),
    { name: 'emaki.lightbox' },
  ),
);
