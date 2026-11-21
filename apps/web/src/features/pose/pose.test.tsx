import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { PoseWearPose } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { qk } from '@/lib/queries';
import { findPoseClass, findPoseWear } from './client';
import { usePrefs } from '@/lib/stores';
import { PoseEntryLazy, PoseInfoRowLazy, PoseLowMark, PoseWearEntryLazy } from './lazy';
import { mannequinShapes, personShapes, placeholderPersons, PoseWearCover, taper } from './mannequin';
import { PoseSettingsSection } from './PoseSettingsSection';
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
              {
                id: 'full_single_P001',
                set: 'full_single' as const,
                number: 'P001',
                name: '后仰坐',
                category: '坐姿',
                count: 4,
                low: 1,
                adult: false,
                hasCover: true,
                thumbUrl: '/api/pose/posewear/t/full_single_P001_high.webp?v=1',
                imageUrl: '',
                skeletonUrl: '/api/pose/posewear-skeleton/full_single_P001',
              },
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
    const m = (p: PoseWearPose, low = false) => ({ pose: p, distance: 0.2, tagScore: 0.4, method: low ? 'lowtag+skel' : 'tags+skel', low, rank: 3, view: 'side', viewThumbUrl: '', viewHasCover: true });
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
    const p = (id: string, adult: boolean, category: string) => ({
      id,
      set: 'pair' as const,
      number: id.slice(5),
      name: id,
      category,
      count: 2,
      low: 0,
      adult,
      hasCover: false,
      thumbUrl: '',
      imageUrl: '',
      skeletonUrl: `/api/pose/posewear-skeleton/${id}`,
    });
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

describe('没有封面时画小木偶', () => {
  // full_single_P017 的骨架（随包资产里取的，侧面视角）
  const P017: [number, number, number][] = [
    [0.3492, 0.1191, 0.474], [0.3478, 0.1031, 0.515], [0.3317, 0.1061, 0.506], [0.3288, 0.1235, 0.509], [0.3595, 0.1235, 0.533],
    [0.339, 0.2213, 0.607], [0.3551, 0.2271, 0.681], [0.339, 0.3352, 0.363], [0.3434, 0.3438, 0.667], [0.3988, 0.4153, 0.206],
    [0.3857, 0.4373, 0.597], [0.3084, 0.4387, 0.743], [0.3623, 0.4431, 0.72], [0.3025, 0.6415, 0.948], [0.3886, 0.6444, 0.851],
    [0.2617, 0.8487, 0.966], [0.428, 0.8662, 1], [0.3259, 0.8983, 0.843], [0.3186, 0.8896, 0.821], [0.2441, 0.8691, 0.901],
    [0.5243, 0.9188, 0.872], [0.5068, 0.9188, 0.857], [0.4163, 0.8896, 0.877],
  ];
  const skel = { poseId: 'full_single_P017', view: 'side', views: ['side'], w: 0.75, h: 1, persons: [{ points: P017 }], edges: [], minConfidence: 0.3 };
  const pose = { set: 'full_single' as const, skeletonUrl: '/api/pose/posewear-skeleton/full_single_P017' };

  it('一个人：躯干、四肢、关节、蛋形头和两条辅助线；看不清的点（左腕 0.206）不画', () => {
    const shapes = personShapes(P017, 0.3);
    const kinds = shapes.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'head')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'guide')).toHaveLength(2);
    // 关节：肩 2、肘 2、腕 1（左腕看不清）、髋 2、膝 2、踝 2
    expect(kinds.filter((k) => k === 'joint')).toHaveLength(11);
    // 躯干 1 + 腿 2×3 + 右胳膊 3 + 左上臂 1 + 脖子 1
    expect(kinds.filter((k) => k === 'limb')).toHaveLength(12);
    expect(shapes.every((s) => !s.d.includes('NaN'))).toBe(true);
    // 头画在最后，盖住脖子
    expect(shapes.findIndex((s) => s.kind === 'head')).toBeGreaterThan(shapes.findLastIndex((s) => s.kind === 'limb'));
  });

  it('双人两组；线稿上没检测到人时画淡的占位（双人也是两个）', () => {
    expect(new Set(mannequinShapes({ persons: [{ points: P017 }, { points: P017 }], minConfidence: 0.3 }).map((s) => s.person))).toEqual(new Set([0, 1]));
    expect(placeholderPersons(true)).toHaveLength(2);
    expect(placeholderPersons(false)).toHaveLength(1);
    expect(personShapes([], 0.3)).toEqual([]);
  });

  it('一头粗一头细的条：两段直线两段弧；一个圆包住另一个时退成圆', () => {
    expect(taper([0, 0], 0.1, [1, 0], 0.05)).toMatch(/^M.+L.+A.+L.+A.+Z$/);
    expect(taper([0, 0], 0.5, [0.1, 0], 0.1).match(/a/g)).toHaveLength(2);
  });

  it('hasCover 是 false：不出 img，画小人（骨架已经在缓存里）；有封面照旧是线稿', () => {
    const client = new QueryClient();
    client.setQueryData(['posewear-skeleton', pose.skeletonUrl], skel);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PoseWearCover pose={pose} src="/api/pose/posewear/t/full_single_P017_side.webp?v=1" hasCover={false} className="w-full" />
      </QueryClientProvider>,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('aria-label="没有封面，按骨架画的小人"');
    expect(html).toContain('viewBox="0 0 0.75 1"');
    expect(html).toContain('var(--c-fg-muted)');
    const withCover = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <PoseWearCover pose={pose} src="/api/pose/posewear/t/full_single_P017_side.webp?v=1" hasCover className="w-full" />
      </QueryClientProvider>,
    );
    expect(withCover).toContain('<img');
    expect(withCover).toContain('full_single_P017_side.webp');
  });

  it('看图器里按匹配上的视角画：骨架地址带 ?view=', () => {
    const client = new QueryClient();
    client.setQueryData(['posewear-skeleton', `${pose.skeletonUrl}?view=high`], { ...skel, persons: [] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PoseWearCover pose={pose} src="" hasCover={false} view="high" mini />
      </QueryClientProvider>,
    );
    // 那个视角没有骨架：淡的占位
    expect(html).toContain('aria-label="没有封面"');
    expect(html).toContain('opacity-40');
  });
});

describe('设置里的姿势检索', () => {
  const job = null;
  const base = {
    enabled: false,
    models: {
      ready: false,
      dir: 'D:/emaki/data/models/yzd-v__DWPose',
      files: [
        { name: 'person_detect_v1.1_m/model.onnx', size: 103_459_671, present: false },
        { name: 'person_detect_v1.1_m/threshold.json', size: 48, present: false },
        { name: 'dw-ll_ucoco_384.onnx', size: 134_399_116, present: false },
      ],
      localSource: null,
      repo: 'deepghs/anime_person_detection、yzd-v/DWPose',
      download: { state: 'idle' as const, file: null, received: 0, total: 0, message: null },
    },
    counts: { eligible: 40, processed: 0, pending: 40, outdated: 0, withPerson: 0, classified: 0 },
    rerun: false,
    tags: { eligible: 40, pending: 40, missingModel: 0, estimateSeconds: 20, lowTags: 0, images: 0, requested: false, job, prototype: null },
    prototype: null as { keypointsPath: string; assignmentsPath: string } | null,
    job,
    posewear: {
      poses: 233,
      assigned: 0,
      pairs: 0,
      low: 0,
      pair: { types: 11, images: 0, shown: 0 },
      defaults: { folder: null, assignmentsPath: null, viewsPath: null, pairsPath: null },
      match: { version: 1, eligible: 0, matched: 0, pending: 0, job },
      covers: { found: 0, total: 244, dir: 'D:/emaki/pose-covers' },
    },
  };
  const render = (status: typeof base, enabled: boolean) => {
    const client = new QueryClient();
    client.setQueryData(qk.settings, { pose: { enabled } });
    client.setQueryData(['pose', 'status'], status);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <MemoryRouter>
            <PoseSettingsSection />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  };

  it('新用户：开关在最上面（可以点，点了先准备模型），下面是下载和从本机复制；没有任何导入', () => {
    const html = render(base, false);
    expect(html.indexOf('开启姿势检索')).toBeLessThan(html.indexOf('姿势模型'));
    expect(html).toContain('现在打开会先带你准备');
    expect(html).toMatch(/下载模型（约 2\d\d/);
    expect(html).toContain('从本机复制…');
    expect(html).not.toContain('导入');
    expect(html).not.toContain('提取姿势');
  });

  it('打开、模型在：提取、匹配的进度在前，可选的几项在后，原型的导入折在「高级」里', () => {
    const on = {
      ...base,
      enabled: true,
      models: { ...base.models, ready: true, files: base.models.files.map((f) => ({ ...f, present: true })) },
      counts: { ...base.counts, processed: 40, pending: 0, outdated: 3, withPerson: 31 },
      prototype: { keypointsPath: 'F:/x/keypoints_lib.npz', assignmentsPath: 'F:/x/assignments.json' },
      posewear: { ...base.posewear, match: { version: 1, eligible: 31, matched: 30, pending: 1, job }, covers: { ...base.posewear.covers, found: 3 } },
    };
    const html = render(on, true);
    const order = ['开启姿势检索', '姿势模型', '提取姿势', '匹配姿势', '可选', '补充姿势标签', '用新的找人模型重新提取', '封面', '高级'];
    const at = order.map((t) => html.indexOf(t));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain('已匹配 30 / 31 张');
    expect(html).toContain('还有 1 张等重新匹配');
    expect(html).toContain('每张约 0.5 秒');
    expect(html).toContain('有封面 3 / 244 个姿势');
    expect(html).toContain('D:/emaki/pose-covers');
    expect(html).toContain('从 PoseWear 文件夹导入封面');
    expect(html).toContain('姿势目录来自 PoseWear（MIT），姿势参考出自 AI Pose Gallery；封面图片不随软件提供。');
    // 「高级」默认折着
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('导入原型的姿势数据');
    expect(html).not.toContain('全部重新匹配');
  });
});
