/**
 * mock 的「按漫画导入」范围（同 services/classify/comicAreas.ts）：整个图库文件夹（mode = 'comic'），
 * 或者图库文件夹里的漫画子文件夹（LibraryRoot.comicFolders），最里层的优先。
 */
import type { ID, LibraryRoot, Rating } from '@emaki/shared';
import type { ComicArea } from '../../services/classify/comicAreas.ts';

export function comicAreaOf(roots: LibraryRoot[], rootId: ID, relPath: string): ComicArea | null {
  const root = roots.find((r) => r.id === rootId);
  if (!root) return null;
  const folders = [...root.comicFolders].sort((a, b) => b.relDir.length - a.relDir.length);
  for (const f of folders) {
    if (relPath === f.relDir || relPath.startsWith(`${f.relDir}/`)) return { relDir: f.relDir, path: `${root.path.replace(/\/+$/, '')}/${f.relDir}`, rating: f.comicRating };
  }
  return root.mode === 'comic' ? { relDir: '', path: root.path, rating: root.comicRating as Rating } : null;
}
