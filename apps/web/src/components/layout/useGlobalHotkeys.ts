import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { isTypingTarget, useHotkey } from '@/lib/hotkeys';
import { useEffect } from 'react';
import { requestUndo, setUndoNavigate } from '@/lib/queries';
import { useLightbox, useOverlays, usePrefs } from '@/lib/stores';

/**
 * 全局快捷键（帮助面板 HelpDialog 里列出的那些）。
 * 页面自己的快捷键写在页面里，别加到这里。
 */
export function useGlobalHotkeys() {
  const navigate = useNavigate();
  const overlays = useOverlays();
  const lightboxOpen = useLightbox((s) => s.open);
  // 未识别页把数字键和 / 用于「采纳建议」和「搜索角色」，全局的跳页 / 命令面板要让路
  const { pathname } = useLocation();
  const onTriage = pathname === '/unrecognized';
  // 阅读器自己处理 b、方向键，数字键和 / 不跳页（T38e）
  const onReader = pathname.endsWith('/read');
  const pageKeys = !lightboxOpen && !onTriage && !onReader;

  // 撤销提示里的「去看看」用路由跳转，不整页刷新
  useEffect(() => {
    setUndoNavigate((href) => void navigate(href));
    return () => setUndoNavigate(null);
  }, [navigate]);

  // 看图器打开时不要在它上面再叠命令面板 / 帮助
  useHotkey('mod+k', () => overlays.setCommandOpen(!overlays.commandOpen), { allowInInputs: true, enabled: !lightboxOpen });
  useHotkey('/', () => overlays.setCommandOpen(true), { enabled: pageKeys });
  useHotkey('shift+?', () => overlays.setHelpOpen(true), { enabled: !lightboxOpen });
  useUndoHotkey();
  useHotkey('b', () => usePrefs.getState().toggleBlurSensitive(), { enabled: !lightboxOpen && !onReader });

  // g 然后 数字 太复杂了，直接用数字键跳转
  useHotkey('1', () => navigate('/'), { enabled: pageKeys });
  useHotkey('2', () => navigate('/gallery'), { enabled: pageKeys });
  useHotkey('3', () => navigate('/characters'), { enabled: pageKeys });
  useHotkey('4', () => navigate('/unrecognized'), { enabled: pageKeys });
  useHotkey('5', () => navigate('/duplicates'), { enabled: pageKeys });
  useHotkey('6', () => navigate('/annex'), { enabled: pageKeys });
}

/**
 * Ctrl+Z 撤销最近一步。可撤销的 toast 上都写着这个键，所以 AppShell 之外的页面（/welcome）也要挂上。
 * inEmptyInputs：焦点在空输入框里也撤销（/welcome 一进来就聚焦路径框）；框里有字时仍让给浏览器撤销打字。
 */
export function useUndoHotkey({ inEmptyInputs = false } = {}) {
  const client = useQueryClient();
  useHotkey(
    'mod+z',
    (e) => {
      if (isTypingTarget(e.target) && !(inEmptyInputs && isEmptyField(e.target))) return;
      e.preventDefault();
      // 别的页面的、超过 2 分钟的先问；问着的时候再按一次就是确认
      requestUndo(client);
    },
    { allowInInputs: true, preventDefault: false },
  );
}

const isEmptyField = (t: EventTarget | null) => (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value === '';
