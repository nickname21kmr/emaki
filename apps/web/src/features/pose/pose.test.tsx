import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { qk } from '@/lib/queries';
import { findPoseClass } from './client';
import { PoseEntryLazy, PoseInfoRowLazy } from './lazy';
import { PoseEntry } from './ui';

const withSettings = (enabled: boolean, node: ReactNode) => {
  const client = new QueryClient();
  client.setQueryData(qk.settings, { pose: { enabled } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const noop = () => {};

describe('姿势检索的界面', () => {
  it('关着时不渲染入口和看图器那一行', () => {
    expect(withSettings(false, <PoseEntryLazy poseClass={undefined} liked={false} onPick={noop} onClear={noop} />)).toBe('');
    expect(withSettings(false, <PoseInfoRowLazy imageId="a" onNavigate={noop} />)).toBe('');
  });

  it('没选类别时是「按姿势」chip', () => {
    const html = withSettings(true, <PoseEntry poseClass={undefined} liked={false} onPick={noop} onClear={noop} />);
    expect(html).toContain('按姿势');
  });

  it('选了类别：小人缩略图 + 名字 + 去掉按钮', () => {
    const client = new QueryClient();
    client.setQueryData(['pose', 'classes'], {
      groups: [{ id: 'full', name: '全身', count: 3, classes: [{ id: 'full_01', group: 'full', name: '站立', description: '全身·站立', count: 3, figureUrl: '/api/pose/classes/full_01/figure.png?v=1' }] }],
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PoseEntry poseClass="full_01" liked onPick={noop} onClear={noop} />
      </QueryClientProvider>,
    );
    expect(html).toContain('站立');
    expect(html).toContain('figure.png?v=1');
    expect(html).toContain('去掉姿势筛选');
    expect(html).toContain('按相近排');
  });

  it('按 id 找类别', () => {
    const data = { groups: [{ id: 'bust' as const, name: '胸像', count: 1, classes: [{ id: 'bust_02', group: 'bust' as const, name: 'x', description: 'y', count: 1, figureUrl: '' }] }] };
    expect(findPoseClass(data, 'bust_02')?.name).toBe('x');
    expect(findPoseClass(data, 'full_01')).toBeUndefined();
  });
});
