import type { ID, ImageItem, ListImagesQuery } from '@emaki/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/queries';
import { useLightbox, usePrefs } from '@/lib/stores';
import { rememberImages } from './cache';

/** 放映（SEL-16）每张停留 6 秒 */
export const SLIDE_MS = 6000;

/**
 * 放映只放插画；开着模糊时只放分级可信的全年龄图
 * （没识别过的图分级默认是全年龄，可能其实是限制级）。
 */
export function slideFilter(blur = usePrefs.getState().blurSensitive): ListImagesQuery {
  return { kind: ['illustration'], ...(blur ? { rating: ['general'], rated: true } : {}) };
}

/** 依次按几组条件分页拉图，去重，凑满 max 张为止 */
export async function collectImages(queries: ListImagesQuery[], max: number): Promise<ImageItem[]> {
  const seen = new Set<ID>();
  const out: ImageItem[] = [];
  for (const q of queries) {
    let cursor: string | undefined;
    do {
      const page = await api.images({ limit: 200, ...q, cursor });
      for (const it of page.items) {
        if (out.length >= max) return out;
        if (!seen.has(it.id)) {
          seen.add(it.id);
          out.push(it);
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && out.length < max);
    if (out.length >= max) break;
  }
  return out;
}

/** 放映入口：拉图期间 pending，拉到就从第一张开始放 */
export function useSlideshow() {
  const [pending, setPending] = useState(false);
  const start = async (load: () => Promise<ImageItem[]>) => {
    if (pending) return;
    setPending(true);
    try {
      const items = await load();
      if (items.length === 0) {
        toast(usePrefs.getState().blurSensitive ? '没有可以放映的插画（开着模糊时只放全年龄的图）' : '没有可以放映的插画');
        return;
      }
      rememberImages(items);
      useLightbox.getState().show(
        items.map((i) => i.id),
        0,
        null,
        null,
        { autoplay: SLIDE_MS },
      );
    } catch (err) {
      toast.error(`放映失败：${errorMessage(err)}`);
    } finally {
      setPending(false);
    }
  };
  return { start: (load: () => Promise<ImageItem[]>) => void start(load), pending };
}
