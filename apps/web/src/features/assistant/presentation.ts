import type { AssistantContext, AssistantMessage, AssistantModel } from '@emaki/shared';
import { KIND_LABEL } from '../../lib/kinds';
import { THEME_META } from '../unrecognized/themes';

/** Keep user choices when available; recover when API configuration changes. */
export function reconcileModelSelection(models: AssistantModel[], current: { model: string; effort: string }, saved: { model: string; effort: string }) {
  const selected = models.find(m => m.id === current.model);
  const remembered = models.find(m => m.id === saved.model);
  const chosen = selected ?? remembered ?? models[0];
  if (!chosen) return { model: '', effort: '' };
  const effort = selected ? current.effort : remembered ? saved.effort : chosen.defaultEffort ?? '';
  return { model: chosen.id, effort: !effort || chosen.efforts.includes(effort) ? effort : chosen.defaultEffort ?? '' };
}

/** Translate saved URLs too, so older messages use the same readable labels. */
export function contextPageLabel(page: string): string {
  let url: URL;
  try { url = new URL(page, 'http://emaki.local'); } catch { return '图库页面'; }
  const parts = url.pathname.split('/').filter(Boolean), section = parts[0] ?? '';
  const p = url.searchParams;
  const names: Record<string, string> = { '': '首页', welcome: '首次设置', gallery: '图库', characters: '角色', works: '作品', unrecognized: '未识别', duplicates: '重复', collections: '合集', annex: '别册', excluded: '已排除', settings: '设置', dev: '界面预览' };
  const labels = [names[section] ?? '图库页面'];
  const kind = (value: string | null | undefined) => value && Object.hasOwn(KIND_LABEL, value) ? KIND_LABEL[value as keyof typeof KIND_LABEL] : undefined;
  if (section === 'characters') {
    if (parts[1]) labels[0] = '角色详情';
    else {
      if (p.get('source') === 'custom') labels.push('自建角色');
      if (p.get('work') === 'recent') labels.push('最近在收');
      else if (p.has('work')) labels.push('按作品筛选');
    }
  } else if (section === 'works' && parts[1]) labels[0] = '作品详情';
  else if (section === 'collections' && parts[1]) labels[0] = parts[2] === 'read' ? '合集阅读' : '合集详情';
  else if (section === 'annex') { const name = kind(parts[1]); if (name) labels.push(name); }
  else if (section === 'unrecognized') {
    if (p.get('area') === 'annex') labels.push('照片 · 文字等', ...(kind(p.get('kind')) ? [kind(p.get('kind'))!] : []));
    else {
      const buckets: Record<string, string> = { suggested: '有建议', unsure: '没认出', untagged: '待识别', shelved: '放下的', books: '成册待整理' };
      const bucket = p.get('bucket') ?? '';
      if (Object.hasOwn(buckets, bucket)) labels.push(buckets[bucket]!);
    }
  }
  const theme = p.get('theme');
  if ((section === 'gallery' || (section === 'unrecognized' && p.get('area') !== 'annex' && p.get('bucket') === 'unsure')) && theme && Object.hasOwn(THEME_META, theme)) labels.push(THEME_META[theme as keyof typeof THEME_META].label);
  if (section === 'gallery') {
    if (p.get('fav') === '1') labels.push('已收藏');
    if (p.has('custom')) labels.push('自定义画面');
    if (p.get('artist')) labels.push(`画师：${p.get('artist')}`);
  }
  if (p.get('q')) labels.push(`搜索：${p.get('q')}`);
  return labels.join(' · ');
}

export const selectionLabel = (count: number) => count ? `已选中 ${count} 张图片` : '未选中图片';

export interface ResultSelection { cardId: string; title: string; ids: string[] }
export function composerContext(page: string, scope: string, selected: ReadonlySet<string>, viewedId: string | undefined, result: ResultSelection | null): AssistantContext {
  return { page, imageIds: viewedId ? [viewedId] : result ? result.ids : [...selected], selectionScope: viewedId ? 'lightbox' : result ? `assistant-result:${result.cardId}` : scope };
}
export function toggleResultImage(current: ResultSelection | null, card: { id: string; title: string }, id: string, checked: boolean): ResultSelection {
  const ids = new Set(current?.ids ?? []);
  if (checked) ids.add(id); else ids.delete(id);
  return { cardId: card.id, title: current && current.cardId !== card.id && current.ids.length ? '助手选择' : card.title, ids: [...ids] };
}

export const isProcessMessage = (message: AssistantMessage) =>
  !message.cards?.length && (message.role === 'tool' || Boolean(message.reasoning));

export function groupMessages(messages: AssistantMessage[]): AssistantMessage[][] {
  const groups: AssistantMessage[][] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (isProcessMessage(message) && previous && isProcessMessage(previous[0]!)) previous.push(message);
    else groups.push([message]);
  }
  return groups;
}

export interface Position { x: number; y: number }
export function clampPosition(position: Position, width: number, height: number, viewportWidth: number, viewportHeight: number): Position {
  return {
    x: Math.max(8, Math.min(position.x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(position.y, viewportHeight - height - 8)),
  };
}
