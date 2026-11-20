import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { qk } from '@/lib/queries';
import { findPoseClass, findPoseWear } from './client';
import { PoseEntryLazy, PoseInfoRowLazy, PoseWearEntryLazy } from './lazy';
import { PoseWearEntry, PoseWearInfoRow } from './posewear';
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

describe('PoseWear 姿势库的界面', () => {
  const catalog = {
    poses: 2,
    sets: [
      {
        id: 'full_single' as const,
        name: '全身',
        count: 4,
        categories: [
          {
            name: '坐姿',
            count: 4,
            poses: [
              { id: 'full_single_P001', set: 'full_single' as const, number: 'P001', name: '后仰坐', category: '坐姿', count: 4, thumbUrl: '/api/pose/posewear/t/full_single_P001_high.webp?v=1', imageUrl: '' },
            ],
          },
        ],
      },
    ],
  };
  const render = (node: ReactNode, setup: (c: QueryClient) => void) => {
    const client = new QueryClient();
    setup(client);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('关着时入口不渲染；开着、没选时是「按姿势」', () => {
    expect(withSettings(false, <PoseWearEntryLazy pose={undefined} onPick={noop} onClear={noop} />)).toBe('');
    expect(render(<PoseWearEntry pose={undefined} onPick={noop} onClear={noop} />, () => {})).toContain('按姿势');
  });

  it('选了姿势：线稿 + 名字 + 去掉按钮', () => {
    const html = render(<PoseWearEntry pose="full_single_P001" onPick={noop} onClear={noop} />, (c) => c.setQueryData(['pose', 'posewear', true], catalog));
    expect(html).toContain('后仰坐');
    expect(html).toContain('full_single_P001_high.webp?v=1');
    expect(html).toContain('去掉姿势筛选');
  });

  it('看图器一行：主要姿势链到 pwPose 筛选，也像的最多两个', () => {
    const pose = catalog.sets[0]!.categories[0]!.poses[0]!;
    const html = render(<PoseWearInfoRow imageId="7" onNavigate={noop} />, (c) =>
      c.setQueryData(['pose', 'posewear-of', '7'], {
        imageId: '7',
        primary: { pose, distance: 0.1, tagScore: 0.5, method: 'tags+skel', rank: 2, viewThumbUrl: '/api/pose/posewear/t/full_single_P001_side.webp?v=1' },
        related: [{ pose: { ...pose, id: 'full_sexy_P002', name: '侧坐' }, distance: 0.2, tagScore: 0.4, method: 'tags+skel', viewThumbUrl: '' }],
      }),
    );
    expect(html).toContain('href="/gallery?pwPose=full_single_P001"');
    expect(html).toContain('full_single_P001_side.webp');
    expect(html).toContain('也像');
    expect(html).toContain('href="/gallery?pwPose=full_sexy_P002"');
    expect(render(<PoseWearInfoRow imageId="8" onNavigate={noop} />, (c) => c.setQueryData(['pose', 'posewear-of', '8'], { imageId: '8', primary: null, related: [] }))).toBe('');
  });

  it('按 id 找姿势', () => {
    expect(findPoseWear(catalog, 'full_single_P001')?.name).toBe('后仰坐');
    expect(findPoseWear(catalog, 'full_single_P002')).toBeUndefined();
  });

  it('51 类的入口要另开 showClasses', () => {
    const client = new QueryClient();
    client.setQueryData(qk.settings, { pose: { enabled: true, showClasses: false } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PoseEntryLazy poseClass={undefined} liked={false} onPick={noop} onClear={noop} />
      </QueryClientProvider>,
    );
    expect(html).toBe('');
  });
});
