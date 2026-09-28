import { useEffect } from 'react';
import { useSettings } from '@/lib/queries';
import { usePrefs } from '@/lib/stores';
import { faviconSvg } from '@/components/ui/Emblem';

/**
 * 把设置里的主题同步到 <html data-theme>。system = 跟随系统（监听变化）。
 * index.html 里有一段内联脚本在首屏前先读 localStorage，避免闪白。
 */
export function ThemeSync() {
  const { data } = useSettings();
  const pref = data?.ui.theme ?? readCached();

  useEffect(() => {
    try {
      localStorage.setItem('emaki.theme', pref);
    } catch {
      /* 隐私模式等情况下忽略 */
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = pref === 'dark' || (pref === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if (pref !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);

  // 底色存在本机偏好里（emaki.prefs），index.html 的内联脚本首屏前也会读它
  const palette = usePrefs((s) => s.palette);
  useEffect(() => {
    document.documentElement.dataset.palette = palette;
  }, [palette]);

  // 标签页图标：简化版徽记，颜色取当前底色 / 明暗下的品牌色
  useEffect(() => {
    const update = () => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--c-brand').trim() || '#c73a27';
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.type = 'image/svg+xml';
      link.href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(color))}`;
    };
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
    return () => mo.disconnect();
  }, []);

  return null;
}

function readCached(): 'system' | 'light' | 'dark' {
  try {
    const v = localStorage.getItem('emaki.theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
