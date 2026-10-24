import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 信息面板占的宽（320 的纸 + 12 的缝）；助手进暗房时 toast 要让开它 */
export const PANEL_W = 332;
/** 窄于这个宽度时信息面板和助手只放一个：332 + 412 之外，图至少还留 500 多 */
export const SIDE_BY_SIDE_MIN = 1280;

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
