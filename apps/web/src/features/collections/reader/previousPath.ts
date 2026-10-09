/** Navigation API 里用到的那一点（Chromium 系都有；不支持的浏览器拿不到） */
export interface NavigationLike {
  currentEntry: { index: number } | null;
  entries(): { url: string | null }[];
}

/** 上一条历史记录的路径；拿不到（第一条、不支持 Navigation API）就是 null */
export function previousPath(nav: NavigationLike | undefined = (globalThis as { navigation?: NavigationLike }).navigation): string | null {
  try {
    const i = nav?.currentEntry?.index ?? -1;
    const url = i > 0 ? nav!.entries()[i - 1]?.url : null;
    return url ? new URL(url).pathname : null;
  } catch {
    return null;
  }
}
