import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DailyPlate, DailyPlateSkeleton } from './DailyPlate';

/** 上次有没有图版（lastPlate 读的那一项） */
const remember = (raw: string | null) => vi.stubGlobal('localStorage', { getItem: () => raw, setItem: () => {} });

const render = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DailyPlate />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('今日一枚：抽到之前占不占位置', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('上次有图版（或者第一次、不知道）：还在抽的时候先画占位，下面几块不会被顶下去', () => {
    for (const raw of ['1', null]) {
      remember(raw);
      expect(render(), String(raw)).toBe(renderToStaticMarkup(<DailyPlateSkeleton />));
    }
  });

  it('上次没有（模糊开着又没分级过、没有可抽的）：什么都不画，免得占位出现又收掉', () => {
    remember('0');
    expect(render()).toBe('');
  });

  it('占位和图版同一套：同样的标题、竖图的图框高 440，手机竖屏上照图版的规矩排', () => {
    const html = renderToStaticMarkup(<DailyPlateSkeleton />);
    expect(html).toContain('今日一枚');
    expect(html).toContain('换一张');
    expect(html).toContain('height:440px');
    expect(html).toContain('compact:grid-cols-1');
    expect(html).toContain('compact:max-h-[70vh]');
    // 读屏不念占位
    expect(html.startsWith('<section aria-hidden')).toBe(true);
  });
});
