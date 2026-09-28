/**
 * 演示数据里的合集（T38c 第 8 节，按 RV-C-4 修正）：一本本子、一个两话的连载、一本画集。
 * 在 buildMockDb 的 return 之前（文件名去重之后）调用；用独立的随机序列，不打乱原来的数据。
 */
import type { ContentKind, ID } from '@emaki/shared';
import type { CharacterRow, CollectionRow, ImageRow, WorkRow } from './fixtures.ts';
import { seededRandom } from './placeholder.ts';

const DAY = 86_400_000;

export function seedCollections(
  db: { images: Map<ID, ImageRow>; characters: Map<ID, CharacterRow>; works: Map<ID, WorkRow>; collections: Map<ID, CollectionRow> },
  now: number,
): void {
  const r = seededRandom(20261001);
  let nextImage = Math.max(...[...db.images.keys()].map((k) => Number(k.slice(1)))) + 1;
  let nextCollection = 1;
  const workByName = (name: string) => [...db.works.values()].find((w) => w.name === name);
  const charsOf = (w: WorkRow | undefined) => (w ? [...db.characters.values()].filter((c) => c.workIds[0] === w.id) : []);
  const ba = workByName('蔚蓝档案');
  const genshin = workByName('原神');
  const baChars = charsOf(ba);
  const genshinChars = charsOf(genshin);

  const book = (
    dir: string,
    files: string[],
    o: { w: number; h: number; kind: (i: number) => ContentKind; chars: (i: number) => CharacterRow | undefined; daysAgo: number },
    row: Omit<CollectionRow, 'id' | 'rootId' | 'relDir' | 'createdAt' | 'updatedAt' | 'manualCharacterIds' | 'manualWorkIds'>,
  ) => {
    const cid = `col${nextCollection++}`;
    const addedAt = new Date(now - o.daysAgo * DAY - Math.floor(r() * 3_600_000)).toISOString();
    files.forEach((file, i) => {
      const id = `i${nextImage++}`;
      const ch = o.chars(i);
      const kind = o.kind(i);
      db.images.set(id, {
        id,
        relPath: `${dir}/${file}`,
        fileName: file,
        libraryRootId: 'root1',
        width: o.w,
        height: o.h,
        bytes: 400_000 + Math.floor(r() * 600_000),
        format: file.endsWith('.png') ? 'png' : 'jpeg',
        addedAt,
        modifiedAt: addedAt,
        rating: r() < 0.2 ? 'sensitive' : 'general',
        characterIds: ch ? [ch.id] : [],
        copyrightWorkIds: ch ? [...ch.workIds] : [],
        hue: Math.floor(r() * 360),
        seed: id,
        source: null,
        favorite: false,
        tags: [{ tag: kind === 'comic' ? 'comic' : '1girl', category: 'general', score: 0.9 }],
        suggestions: [],
        tagged: true,
        excludedBy: null,
        trashed: false,
        kind,
        autoKind: kind,
        kindSource: 'tags',
        kindEvidence: null,
        collectionId: cid,
        pageNo: i + 1,
      });
    });
    const at = new Date(now).toISOString();
    db.collections.set(cid, { ...row, id: cid, rootId: 'root1', relDir: dir, createdAt: at, updatedAt: at, manualCharacterIds: [], manualWorkIds: [] });
  };

  const base = {
    kindManual: false,
    titleManual: false,
    seriesManual: false,
    coverImageId: null,
    origin: 'auto' as const,
    state: 'active' as const,
    reviewedAt: null,
    event: null,
    circle: null,
    artist: null,
    parody: null,
    translator: null,
    seriesKey: null,
    volumeNo: null,
  };
  const pad = (i: number, n: number) => String(i).padStart(n, '0');

  // ① 本子：第 1 页是彩色封面，其余漫画页；6 页有蔚蓝档案的第一个角色
  book(
    '(C104) [示例社 (作者甲)] 午后的约定 (蔚蓝档案) [示例汉化组]',
    Array.from({ length: 24 }, (_, i) => `${pad(i + 1, 3)}.jpg`),
    { w: 1200, h: 1700, kind: (i) => (i === 0 ? 'illustration' : 'comic'), chars: (i) => (i >= 2 && i < 8 ? baChars[0] : undefined), daysAgo: 6 },
    {
      ...base,
      kind: 'doujin',
      kindSource: 'pages',
      title: '午后的约定',
      event: 'C104',
      circle: '示例社',
      artist: '作者甲',
      parody: '蔚蓝档案',
      translator: '示例汉化组',
      pageOrder: 'name',
      evidence: '文件名是页码（24/24） · 23/24 页是漫画',
    },
  );
  // ② 连载两话：漫画页，没有角色
  for (const [no, n] of [
    [1, 16],
    [2, 18],
  ] as const) {
    book(
      `示例连载 ${no}话`,
      Array.from({ length: n }, (_, i) => `${pad(i + 1, 2)}.jpg`),
      { w: 1200, h: 1700, kind: () => 'comic', chars: () => undefined, daysAgo: 20 - no },
      {
        ...base,
        kind: 'doujin',
        kindSource: 'pages',
        title: '示例连载',
        seriesKey: '示例连载',
        volumeNo: no,
        pageOrder: 'name',
        evidence: `文件名是页码（${n}/${n}） · ${n}/${n} 页是漫画`,
      },
    );
  }
  // ③ 画集：25 页各有一个原神角色，5 页没认出
  book(
    '示例画师画集',
    Array.from({ length: 30 }, (_, i) => `p${pad(i + 1, 2)}.png`),
    {
      w: 1414,
      h: 2000,
      kind: () => 'illustration',
      chars: (i) => (i < 25 && genshinChars.length ? genshinChars[i % genshinChars.length] : undefined),
      daysAgo: 40,
    },
    {
      ...base,
      kind: 'artbook',
      kindSource: 'pages',
      title: '示例画师画集',
      artist: '示例画师',
      pageOrder: 'name',
      evidence: '文件名是页码（30/30） · 0/30 页是漫画',
    },
  );
}
