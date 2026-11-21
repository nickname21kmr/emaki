import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { PoseWearPose } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { qk } from '@/lib/queries';
import { findPoseClass, findPoseWear } from './client';
import { usePrefs } from '@/lib/stores';
import { PoseEntryLazy, PoseInfoRowLazy, PoseLowMark, PoseWearEntryLazy } from './lazy';
import { PoseWearEntry, PoseWearInfoRow, shownCount, visibleMatches, withoutAdult } from './posewear';
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
              { id: 'full_single_P001', set: 'full_single' as const, number: 'P001', name: '后仰坐', category: '坐姿', count: 4, low: 1, adult: false, thumbUrl: '/api/pose/posewear/t/full_single_P001_high.webp?v=1', imageUrl: '' },
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

  it('选了姿势、这个姿势有低置信的图：chip 里有「只看可靠的」，记在本机偏好里', () => {
    // 服务端渲染读的是偏好的初始值（关）
    const html = render(<PoseWearEntry pose="full_single_P001" onPick={noop} onClear={noop} />, (c) => c.setQueryData(['pose', 'posewear', true], catalog));
    expect(html).toContain('只看可靠的');
    expect(html).toContain('aria-pressed="false"');
    expect(usePrefs.getState().poseReliableOnly).toBe(false);
    usePrefs.getState().setPoseReliableOnly(true);
    expect(usePrefs.getState().poseReliableOnly).toBe(true);
    usePrefs.getState().setPoseReliableOnly(false);
    const none = { ...catalog, sets: [{ ...catalog.sets[0]!, categories: [{ ...catalog.sets[0]!.categories[0]!, poses: [{ ...catalog.sets[0]!.categories[0]!.poses[0]!, low: 0 }] }] }] };
    expect(render(<PoseWearEntry pose="full_single_P001" onPick={noop} onClear={noop} />, (c) => c.setQueryData(['pose', 'posewear', true], none))).not.toContain('只看可靠的');
  });

  it('看图器一行：主要姿势链到 pwPose 筛选，其他匹配上的全列（低置信标「低」，双人另一行；成人的模糊时不列）', () => {
    const pose = catalog.sets[0]!.categories[0]!.poses[0]!;
    const m = (p: PoseWearPose, low = false) => ({ pose: p, distance: 0.2, tagScore: 0.4, method: low ? 'lowtag+skel' : 'tags+skel', low, rank: 3, viewThumbUrl: '' });
    const data = {
      imageId: '7',
      primary: { ...m(pose), viewThumbUrl: '/api/pose/posewear/t/full_single_P001_side.webp?v=1' },
      related: [
        m({ ...pose, id: 'full_sexy_P002', name: '侧坐' }),
        m({ ...pose, id: 'full_single_P009', name: '盘腿' }),
        m({ ...pose, id: 'upper80v2_P004', name: '托腮' }, true),
        m({ ...pose, id: 'pair_P054', set: 'pair', name: '公主抱', category: '双人' }),
        m({ ...pose, id: 'pair_P023', set: 'pair', name: '面对面跨坐', category: '成人', adult: true }),
      ],
    };
    // 服务端渲染读的是偏好的初始值：模糊开着
    const html = render(<PoseWearInfoRow imageId="7" onNavigate={noop} />, (c) => c.setQueryData(['pose', 'posewear-of', '7'], data));
    expect(html).toContain('href="/gallery?pwPose=full_single_P001"');
    expect(html).toContain('full_single_P001_side.webp');
    expect(html).toContain('也像');
    // 不再只给两个
    for (const id of ['full_sexy_P002', 'full_single_P009', 'upper80v2_P004', 'pair_P054']) expect(html).toContain(`href="/gallery?pwPose=${id}"`);
    expect(html.match(/>低</g)).toHaveLength(1);
    expect(html).toContain('双人');
    expect(html).not.toContain('pair_P023');
    expect(visibleMatches(data, true).map((x) => x.pose.id)).toContain('pair_P023');
    expect(visibleMatches(data, false).map((x) => x.pose.id)).not.toContain('pair_P023');
    expect(render(<PoseWearInfoRow imageId="8" onNavigate={noop} />, (c) => c.setQueryData(['pose', 'posewear-of', '8'], { imageId: '8', primary: null, related: [] }))).toBe('');
  });

  it('双人的成人一类：模糊敏感图时整类去掉（空了的分类、套也去掉）；只看可靠的时张数去掉低置信', () => {
    const p = (id: string, adult: boolean, category: string) => ({ id, set: 'pair' as const, number: id.slice(5), name: id, category, count: 2, low: 0, adult, thumbUrl: '', imageUrl: '' });
    const pair = {
      id: 'pair' as const,
      name: '双人',
      count: 4,
      categories: [
        { name: '双人', count: 2, poses: [p('pair_P054', false, '双人')] },
        { name: '成人', count: 2, poses: [p('pair_P023', true, '成人')] },
      ],
    };
    const blurred = withoutAdult([catalog.sets[0]!, pair], false);
    expect(blurred.map((s) => [s.id, s.count, s.categories.map((c) => c.name)])).toEqual([
      ['full_single', 4, ['坐姿']],
      ['pair', 2, ['双人']],
    ]);
    const onlyAdult = { ...pair, categories: [pair.categories[1]!] };
    expect(withoutAdult([onlyAdult], false)).toEqual([]);
    expect(withoutAdult([pair], true)[0]!.categories).toHaveLength(2);
    expect([shownCount({ count: 10, low: 3 }, true), shownCount({ count: 10, low: 3 }, false)]).toEqual([7, 10]);
  });

  it('网格上的「低」小签', () => {
    expect(renderToStaticMarkup(<PoseLowMark />)).toContain('低');
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
