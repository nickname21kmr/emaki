/**
 * 契约测试夹具：小而全、完全确定（不用随机数）。mock 直接用它，sqlite 通过 seedFromMockDb 导入它。
 *
 * NOW = 2026-09-27T12:00:00Z（本地时间是下午 / 晚上，离午夜足够远，7 天分桶不受时区影响）
 *
 * 图库文件夹
 *   root1  D:/Pics  启用，上次扫描 NOW-2h    i1–i38
 *   root2  E:/Old   停用，上次扫描 NOW-10d   i39–i41（停用 → 全部不可见）
 *
 * 作品：w1 蔚蓝档案(blue_archive, 别名 ブルーアーカイブ / BA)  w2 原神(genshin_impact)  w3 我的原创(自建, 无标签)
 * 角色：c1 圣园未花(w1, 别名 ミカ / 未花)  c2 早濑优香(w1)  c3 空崎日奈(w1, 置顶)
 *       c4 芙宁娜(w2)  c5 纳西妲(w2)  c6 联动角色(w1 + w2)  c7 雪见(自建, w3)
 *
 * 图片（天数 = 入库距 NOW 的天数；「计入」= 可见且未排除）
 *   c1：i1(0,收藏) i2(0) i3(3,横) i4(10) i5(40,方) i6(400) i7(3,+c2) i8(10,+c3)     → 计入 8
 *   c2：i7 i9(0) i10(40) i11(400)                                                   → 计入 4
 *   c3：i8 i12(3) i13(10)                                                           → 计入 3
 *   c4：i14(0) i15(3) i16(10) i17(40) i18(400) i37(3, 与 i15 重复)                   → 计入 6
 *   c5：i19(10) i20(40) i38(40, 与 i20 重复、已处理)                                  → 计入 3
 *   c6：i21(3) i22(400)                                                             → 计入 2
 *   c7：i23(40)                                                                     → 计入 1
 *   未识别：i24(3, 只有 w1 作品, 建议 c1) i25(40, 只有 w2 作品) i26(0, 建议 c1/c2)
 *           i27(3, 建议 test_girl_(emaki_test)——库里不存在的标签) i28(10, 建议 c3) i29(40, 建议 c4) i30(400, 未打标签)
 *   排除：x1 文件夹 D:/Pics/memes → i31(c1, 0) i32(未识别, 3)；x2 标签 comic → i33(c4, 10) i34(未识别, 40)
 *   回收站：i35(c1, 0) i36(c2, 3)
 *   停用文件夹：i39(c1) i40(c1) i41(c4)
 *
 * 预期（全部基于 NOW）
 *   可见 36（i1–i38 去掉回收站 2 张），其中排除 4 → 计入 32；每张 100,000 字节 → totalBytes 3,200,000
 *   unrecognizedCount 7（i24–i30）；excludedCount 4；duplicateGroupCount 1（d1）
 *   characterCount 7；workCount 3
 *   作品张数：w1 16（c1 8 + c2 另 3 + c3 另 2 + c6 2 + i24）；w2 12（c4 6 + c5 3 + c6 2 + i25）；w3 1
 *   作品 recent（30 天内）：w1 11；w2 6；w3 0
 *   作品 characterCount：w1 4（c1 c2 c3 c6）；w2 3（c4 c5 c6）；w3 1
 *   addedLast7Days = [0, 0, 0, 8, 0, 0, 5]（今天 i1 i2 i9 i14 i26；3 天前 i3 i7 i12 i15 i21 i24 i27 i37）
 *   lastScanAt = NOW-2h
 *   角色默认排序（置顶在前，再按张数）：c3, c1, c4, c2, c5, c6, c7
 *   topCharacters（只按张数，同数保持原顺序）：c1, c4, c2, c3, c5, c6, c7
 *   30 天内有新图的角色（workId=recent）：c1 c2 c3 c4 c5 c6（c7 只有 40 天前的图）
 *   c1 的同框：c2（1 张，i7）、c3（1 张，i8）
 *   设置里文件夹张数（未进回收站、未排除）：root1 32，root2 3
 */
import type { ImageFormat, Rating, Settings, TagScore } from '@emaki/shared';
import type { CharacterRow, DuplicateRow, ExclusionRow, ImageRow, MockDb, WorkRow } from '../../src/datasource/mock/fixtures.ts';

const DAY = 86_400_000;
const MIN = 60_000;

interface Spec {
  id: string;
  chars?: string[];
  cw?: string[];
  days: number;
  rating?: Rating;
  shape?: 'portrait' | 'landscape' | 'square';
  fav?: boolean;
  tagged?: boolean;
  sug?: [string, number][];
  folder?: string;
  tags?: string[];
  root?: 'root1' | 'root2';
  trashed?: boolean;
}

const SPECS: Spec[] = [
  { id: 'i1', chars: ['c1'], days: 0, fav: true },
  { id: 'i2', chars: ['c1'], days: 0, rating: 'sensitive' },
  { id: 'i3', chars: ['c1'], days: 3, shape: 'landscape' },
  { id: 'i4', chars: ['c1'], days: 10, rating: 'questionable' },
  { id: 'i5', chars: ['c1'], days: 40, shape: 'square' },
  { id: 'i6', chars: ['c1'], days: 400, rating: 'explicit' },
  { id: 'i7', chars: ['c1', 'c2'], days: 3 },
  { id: 'i8', chars: ['c1', 'c3'], days: 10 },
  { id: 'i9', chars: ['c2'], days: 0 },
  { id: 'i10', chars: ['c2'], days: 40 },
  { id: 'i11', chars: ['c2'], days: 400 },
  { id: 'i12', chars: ['c3'], days: 3 },
  { id: 'i13', chars: ['c3'], days: 10 },
  { id: 'i14', chars: ['c4'], days: 0 },
  { id: 'i15', chars: ['c4'], days: 3, shape: 'landscape' },
  { id: 'i16', chars: ['c4'], days: 10 },
  { id: 'i17', chars: ['c4'], days: 40 },
  { id: 'i18', chars: ['c4'], days: 400 },
  { id: 'i19', chars: ['c5'], days: 10 },
  { id: 'i20', chars: ['c5'], days: 40 },
  { id: 'i21', chars: ['c6'], days: 3 },
  { id: 'i22', chars: ['c6'], days: 400 },
  { id: 'i23', chars: ['c7'], days: 40 },
  { id: 'i24', cw: ['w1'], days: 3, sug: [['mika_(blue_archive)', 0.6]] },
  { id: 'i25', cw: ['w2'], days: 40, tags: ['thighhighs'] }, // 「腿·足」主题（T34a）
  { id: 'i26', days: 0, sug: [['mika_(blue_archive)', 0.7], ['yuuka_(blue_archive)', 0.2]] },
  { id: 'i27', days: 3, sug: [['test_girl_(emaki_test)', 0.5]] },
  { id: 'i28', days: 10, sug: [['hina_(blue_archive)', 0.4]] },
  { id: 'i29', days: 40, sug: [['furina_(genshin_impact)', 0.3]] },
  { id: 'i30', days: 400, tagged: false },
  { id: 'i31', chars: ['c1'], days: 0, folder: 'memes' },
  { id: 'i32', days: 3, folder: 'memes' },
  { id: 'i33', chars: ['c4'], days: 10, tags: ['comic'] },
  { id: 'i34', days: 40, tags: ['comic'] },
  { id: 'i35', chars: ['c1'], days: 0, trashed: true },
  { id: 'i36', chars: ['c2'], days: 3, trashed: true },
  { id: 'i37', chars: ['c4'], days: 3, shape: 'landscape' },
  { id: 'i38', chars: ['c5'], days: 40 },
  { id: 'i39', chars: ['c1'], days: 3, root: 'root2' },
  { id: 'i40', chars: ['c1'], days: 10, root: 'root2' },
  { id: 'i41', chars: ['c4'], days: 40, root: 'root2' },
];

const WORKS: WorkRow[] = [
  { id: 'w1', name: '蔚蓝档案', danbooruTag: 'blue_archive', aliases: ['ブルーアーカイブ', 'BA'], hue: 205 },
  { id: 'w2', name: '原神', danbooruTag: 'genshin_impact', aliases: ['げんしん'], hue: 42 },
  { id: 'w3', name: '我的原创', danbooruTag: null, aliases: [], hue: 30 },
];

const char = (
  id: string,
  name: string,
  tag: string | null,
  workIds: string[],
  aliases: string[] = [],
  extra: Partial<CharacterRow> = {},
): CharacterRow => ({
  id,
  name,
  danbooruTag: tag,
  source: tag ? 'danbooru' : 'custom',
  aliases,
  workIds,
  newCount: 0,
  coverImageId: null,
  coverFocus: null,
  pinned: false,
  ...extra,
});

const CHARACTERS: CharacterRow[] = [
  char('c1', '圣园未花', 'mika_(blue_archive)', ['w1'], ['ミカ', '未花'], { newCount: 2, coverImageId: 'i1', coverFocus: { x: 0.5, y: 0.3 } }),
  char('c2', '早濑优香', 'yuuka_(blue_archive)', ['w1'], ['ユウカ']),
  char('c3', '空崎日奈', 'hina_(blue_archive)', ['w1'], ['ヒナ'], { pinned: true }),
  char('c4', '芙宁娜', 'furina_(genshin_impact)', ['w2'], ['フリーナ'], { newCount: 1, coverImageId: 'i14' }),
  char('c5', '纳西妲', 'nahida_(genshin_impact)', ['w2']),
  char('c6', '联动角色', 'crossover_(emaki_test)', ['w1', 'w2']),
  char('c7', '雪见', null, ['w3'], ['yukimi']),
];

const SIZE: Record<'portrait' | 'landscape' | 'square', [number, number]> = {
  portrait: [1200, 1700],
  landscape: [1920, 1080],
  square: [1500, 1500],
};

export function buildContractDb(now: number): MockDb {
  const works = new Map(WORKS.map((w) => [w.id, structuredClone(w)]));
  const characters = new Map(CHARACTERS.map((c) => [c.id, structuredClone(c)]));
  const images = new Map<string, ImageRow>();

  SPECS.forEach((s, i) => {
    const [width, height] = SIZE[s.shape ?? 'portrait'];
    const format: ImageFormat = i % 2 ? 'jpeg' : 'png';
    const fileName = `${s.id}.${format === 'jpeg' ? 'jpg' : 'png'}`;
    // 同一天的图按编号错开几分钟，排序稳定
    const addedMs = now - s.days * DAY - (i + 1) * MIN;
    // 自建角色没有 Danbooru 标签，不产生 character 标签
    const charTags: TagScore[] = (s.chars ?? []).flatMap((cid) => {
      const tag = characters.get(cid)!.danbooruTag;
      return tag ? [{ tag, category: 'character' as const, score: 0.95 }] : [];
    });
    const tags: TagScore[] = [
      { tag: '1girl', category: 'general', score: 0.9 },
      ...(s.tags ?? []).map((t): TagScore => ({ tag: t, category: 'general', score: 0.8 })),
      ...charTags,
    ];
    const hue = works.get(characters.get(s.chars?.[0] ?? '')?.workIds[0] ?? s.cw?.[0] ?? 'w3')!.hue;
    images.set(s.id, {
      id: s.id,
      relPath: `${s.folder ?? (s.chars?.length ? '角色' : '未整理')}/${fileName}`,
      fileName,
      libraryRootId: s.root ?? 'root1',
      width,
      height,
      bytes: 100_000,
      format,
      addedAt: new Date(addedMs).toISOString(),
      modifiedAt: new Date(addedMs - DAY).toISOString(),
      rating: s.rating ?? 'general',
      characterIds: s.chars ?? [],
      copyrightWorkIds: s.cw ?? [],
      hue,
      seed: s.id,
      source: null,
      favorite: s.fav ?? false,
      tags,
      suggestions: s.sug ?? [],
      tagged: s.tagged ?? true,
      excludedBy: null,
      trashed: s.trashed ?? false,
    });
  });

  const exclusions: ExclusionRow[] = [
    { id: 'x1', kind: 'folder', target: 'D:/Pics/memes', label: '文件夹 · D:/Pics/memes', createdAt: new Date(now - 5 * DAY).toISOString() },
    { id: 'x2', kind: 'tag', target: 'comic', label: '标签 · comic', createdAt: new Date(now - 4 * DAY).toISOString() },
  ];
  for (const id of ['i31', 'i32']) images.get(id)!.excludedBy = 'x1';
  for (const id of ['i33', 'i34']) images.get(id)!.excludedBy = 'x2';

  const duplicates: DuplicateRow[] = [
    { id: 'd1', kind: 'similar', similarity: 0.95, imageIds: ['i15', 'i37'], suggestedKeepId: 'i15', resolved: false },
    { id: 'd2', kind: 'exact', similarity: 1, imageIds: ['i20', 'i38'], suggestedKeepId: 'i20', resolved: true },
  ];

  const settings: Settings = {
    libraryRoots: [
      { id: 'root1', path: 'D:/Pics', enabled: true, imageCount: 0, lastScanAt: new Date(now - 2 * 3_600_000).toISOString(), importedAt: null },
      { id: 'root2', path: 'E:/Old', enabled: false, imageCount: 0, lastScanAt: new Date(now - 10 * DAY).toISOString(), importedAt: null },
    ],
    tagger: {
      model: 'A1yCE/pixai-tagger-v1.0-onnx-fp16',
      device: 'dml',
      generalThreshold: 0.35,
      characterThreshold: 0.35,
      autoAcceptThreshold: 0.85,
      batchSize: 8,
      legacyModel: 'SmilingWolf/wd-eva02-large-tagger-v3',
      legacyBefore: '2024-03-01',
      skipCameraPhotos: true,
      retryOld: false,
      keepAwake: true,
    },
    danbooru: { enabled: false, username: '', hasApiKey: false, lastSyncAt: null },
    dedupe: { hammingThreshold: 8, lastRunAt: null },
    ui: { theme: 'system', blurSensitive: true, density: 'comfortable' },
    browse: { customThemes: [] },
  };

  return { works, characters, images, duplicates, exclusions, settings, collections: new Map() };
}
