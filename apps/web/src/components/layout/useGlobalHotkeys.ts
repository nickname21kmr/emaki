import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { useHotkey } from '@/lib/hotkeys';
import { undo } from '@/lib/queries';
import { useLightbox, useOverlays, usePrefs, useUndoStore } from '@/lib/stores';

/**
 * 全局快捷键（帮助面板 HelpDialog 里列出的那些）。
 * 页面自己的快捷键写在页面里，别加到这里。
 */
export function useGlobalHotkeys() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const overlays = useOverlays();
  const lightboxOpen = useLightbox((s) => s.open);
  // 未识别页把数字键和 / 用于「采纳建议」和「搜索角色」，全局的跳页 / 命令面板要让路
  const { pathname } = useLocation();
  const onTriage = pathname === '/unrecognized';
  // 阅读器自己处理 b、方向键，数字键和 / 不跳页（T38e）
  const onReader = pathname.endsWith('/read');
  const pageKeys = !lightboxOpen && !onTriage && !onReader;

  // 看图器打开时不要在它上面再叠命令面板 / 帮助
  useHotkey('mod+k', () => overlays.setCommandOpen(!overlays.commandOpen), { allowInInputs: true, enabled: !lightboxOpen });
  useHotkey('/', () => overlays.setCommandOpen(true), { enabled: pageKeys });
  useHotkey('shift+?', () => overlays.setHelpOpen(true), { enabled: !lightboxOpen });
  useHotkey('mod+z', () => {
    const top = useUndoStore.getState().entries[0];
    if (top) void undo(top.token, client);
  });
  useHotkey('b', () => usePrefs.getState().toggleBlurSensitive(), { enabled: !lightboxOpen && !onReader });

  // g 然后 数字 太复杂了，直接用数字键跳转
  useHotkey('1', () => navigate('/'), { enabled: pageKeys });
  useHotkey('2', () => navigate('/gallery'), { enabled: pageKeys });
  useHotkey('3', () => navigate('/characters'), { enabled: pageKeys });
  useHotkey('4', () => navigate('/unrecognized'), { enabled: pageKeys });
  useHotkey('5', () => navigate('/duplicates'), { enabled: pageKeys });
  useHotkey('6', () => navigate('/annex'), { enabled: pageKeys });
}
